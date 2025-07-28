// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import pkg from "pg";
const { Pool } = pkg;

const app = express();

const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";
const DATABASE_URL = process.env.DATABASE_URL;

if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render.");
    process.exit(1);
}
if (!DATABASE_URL) {
    console.error("Erro: Variável de ambiente DATABASE_URL não configurada no Render.");
    process.exit(1);
}

// Middlewares
app.use(cors({
    origin: 'https://freefirereward.site',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// REMOVIDA A LINHA process.exit(-1) AQUI para maior resiliência
pool.on('error', (err) => {
    console.error('Erro inesperado no cliente do DB:', err);
    // Não encerra o processo, apenas loga o erro. O pool tentará reconectar.
});

app.get("/", (req, res) => {
    res.send("Servidor PagueEasy está online!");
});

app.get("/my-server-ip", async (req, res) => {
    try {
        const response = await fetch("https://api.ipify.org?format=json");
        const data = await response.json();
        res.json({ ip: data.ip });
    } catch (error) {
        console.error("Erro ao obter IP:", error);
        res.status(500).json({ error: "Erro ao obter IP do servidor" });
    }
});

app.post("/create-payment", async (req, res) => {
    const { amount, email, name, document, phone, product_id, product_name, offer_id, offer_name, discount_price, quantity, tracking } = req.body;

    if (!amount || !email || !name) {
        return res.status(400).json({ error: "Dados obrigatórios (amount, email, name) estão faltando." });
    }

    const externalId = `order_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    console.log(`Gerando pagamento para ${email} com externalId: ${externalId}`);

    const amountInCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountInCents) || amountInCents < 500) {
        return res.status(400).json({ error: "Valor de pagamento inválido ou abaixo do mínimo de R$5,00." });
    }

    let cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    if (cleanPhone.length < 12) {
        if (cleanPhone.length === 9) {
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 11) {
             cleanPhone = `55${cleanPhone}`;
        } else if (cleanPhone.length < 10) {
            cleanPhone = "5511987654321";
        }
    }
    cleanPhone = cleanPhone.substring(0, 13);

    let offerPayload = null;
    if (!offer_id && !offer_name && (discount_price === null || discount_price === undefined)) {
        offerPayload = { id: "", name: "", discount_price: 0, quantity: 0 };
    } else {
         offerPayload = {
            id: offer_id || "default_offer_id",
            name: offer_name || "Oferta Padrão",
            discount_price: (discount_price !== null && discount_price !== undefined) ? Math.round(parseFloat(discount_price) * 100) : 0,
            quantity: quantity || 1
        };
    }

    let buckpayTracking = {};
    buckpayTracking.utm_source = tracking?.utm_source || 'direct';
    buckpayTracking.utm_medium = tracking?.utm_medium || 'website';
    buckpayTracking.utm_campaign = tracking?.utm_campaign || 'no_campaign';
    buckpayTracking.src = tracking?.utm_source || 'direct'; // Usamos utm_source para src
    buckpayTracking.utm_id = tracking?.xcod || tracking?.cid || externalId; // prioriza xcod, depois cid, depois externalId
    buckpayTracking.ref = tracking?.cid || externalId;
    buckpayTracking.sck = tracking?.sck || 'no_sck_value';
    buckpayTracking.utm_term = tracking?.utm_term || '';
    buckpayTracking.utm_content = tracking?.utm_content || '';

    const payload = {
        external_id: externalId,
        payment_method: "pix",
        amount: amountInCents,
        buyer: {
            name: name,
            email: email,
            document: document,
            phone: cleanPhone
        },
        product: product_id && product_name ? { id: product_id, name: product_name } : null,
        offer: offerPayload,
        tracking: buckpayTracking
    };

    console.log("Payload FINAL enviado para BuckPay:", JSON.stringify(payload, null, 2));

    let client;
    try {
        const response = await fetch(BUCK_PAY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BUCK_PAY_API_KEY}`,
                "User-Agent": "Buckpay API"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            console.error(`Erro ao criar pagamento na BuckPay (HTTP status ${response.status}):`, errorDetails);
            return res.status(response.status).json({
                success: false,
                error: "Erro ao criar pagamento na BuckPay.",
                details: errorDetails,
                http_status: response.status
            });
        }

        const data = await response.json();
        console.log("Resposta da BuckPay:", JSON.stringify(data, null, 2));

        if (data.data && data.data.pix && data.data.pix.qrcode_base64) {
            // Tenta salvar no DB APENAS SE A GERAÇÃO DO PIX FOI BEM SUCEDIDA
            try {
                client = await pool.connect();
                const insertQuery = `
                    INSERT INTO transactions (external_id, status, amount, buyer_email, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, NOW(), NOW())
                    RETURNING id;
                `;
                const resDb = await client.query(insertQuery, [externalId, data.data.status, amount, email]);
                console.log(`Transação ${externalId} salva no DB com ID interno: ${resDb.rows[0].id}`);
            } catch (dbError) {
                console.error(`❌ Erro ao salvar transação ${externalId} no DB:`, dbError);
                // IMPORTANTE: Mesmo que falhe o DB, a BuckPay já gerou o Pix.
                // Informa o erro de DB ao cliente, mas o QR Code é o mais importante.
                // Considere se você quer que o erro de DB impeça a resposta.
                // Por agora, vamos retornar o Pix mesmo com erro no DB.
            } finally {
                if (client) {
                    client.release();
                }
            }

            res.status(200).json({
                pix: {
                    code: data.data.pix.code,
                    qrcode_base64: data.data.pix.qrcode_base64
                },
                transactionId: externalId // Garante que o transactionId é enviado
            });
        } else {
            console.error("Resposta inesperada da BuckPay (sem PIX):", data);
            res.status(500).json({ success: false, error: "Resposta inesperada da BuckPay (PIX não gerado)." });
        }

    } catch (error) {
        console.error("Erro ao processar criação de pagamento (requisição BuckPay ou DB):", error);
        // Esse erro pode ser tanto da requisição fetch quanto da tentativa de conexão com o DB antes do try/catch interno.
        res.status(500).json({ success: false, error: "Erro interno ao criar pagamento." });
    }
});

app.post("/webhook/buckpay", async (req, res) => {
    const event = req.body.event;
    const data = req.body.data; // Os dados enviados pela BuckPay no webhook

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${data.status}', ID BuckPay: '${data.id}', External ID: '${data.external_id}'`);

    // **CORREÇÃO AQUI para garantir que external_id seja lido do data**
    const externalId = data?.external_id; // Usa optional chaining para segurança

    if (event && data && externalId && data.status) { // Verifica se externalId existe e não é undefined
        const newStatus = data.status;

        let client;
        try {
            client = await pool.connect();
            const updateQuery = `
                UPDATE transactions
                SET status = $1, updated_at = NOW()
                WHERE external_id = $2;
            `;
            const resDb = await client.query(updateQuery, [newStatus, externalId]);

            if (resDb.rowCount > 0) {
                console.log(`✅ Status da transação ${externalId} atualizado para '${newStatus}' no DB via webhook.`);
            } else {
                console.warn(`⚠️ Webhook para externalId ${externalId} recebido, mas transação não encontrada no DB para atualizar. (Pode ser que o erro de DB anterior impediu o save inicial)`);
            }
        } catch (dbError) {
            console.error(`❌ Erro ao atualizar DB via webhook para externalId ${externalId}:`, dbError);
            return res.status(500).send("Erro interno ao processar webhook (DB).");
        } finally {
            if (client) {
                client.release();
            }
        }
    } else {
        console.warn(`⚠️ Webhook recebido com dados inválidos ou evento não esperado. Evento: ${event}, Status: ${data?.status}, External ID: ${externalId}`);
    }

    res.status(200).send("Webhook recebido com sucesso!");
});

app.get("/check-order-status", async (req, res) => {
    const externalId = req.query.id;

    if (!externalId) {
        return res.status(400).json({ error: "ID externo da transação não fornecido." });
    }

    let client;
    try {
        client = await pool.connect();
        const selectQuery = `
            SELECT status FROM transactions WHERE external_id = $1;
        `;
        const resDb = await client.query(selectQuery, [externalId]);

        if (resDb.rows.length > 0) {
            const transactionStatus = resDb.rows[0].status;
            res.status(200).json({ success: true, status: transactionStatus });
        } else {
            res.status(404).json({ success: false, error: "Transação não encontrada no DB." });
        }
    } catch (dbError) {
        console.error(`❌ Erro ao consultar DB para externalId ${externalId}:`, dbError);
        res.status(500).json({ error: "Erro interno ao consultar status no DB." });
    } finally {
        if (client) {
            client.release();
        }
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));