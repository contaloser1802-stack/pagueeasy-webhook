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

pool.on('error', (err) => {
    console.error('Erro inesperado no cliente do DB:', err);
    process.exit(-1);
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
    // Desestrutura os dados do frontend
    const { amount, email, name, document, phone, product_id, product_name, offer_id, offer_name, discount_price, quantity, tracking } = req.body;

    if (!amount || !email || !name) {
        return res.status(400).json({ error: "Dados obrigatórios (amount, email, name) estão faltando." });
    }

    const externalId = `order_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    console.log(`Gerando pagamento para ${email} com externalId: ${externalId}`);

    // --- CORREÇÕES APLICADAS AQUI ---

    // 1. amount: Convertendo para centavos e inteiro (já estava certo, só reconfirmando)
    const amountInCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountInCents) || amountInCents < 500) { // Mínimo de 500 centavos (R$5,00)
        return res.status(400).json({ error: "Valor de pagamento inválido ou abaixo do mínimo de R$5,00." });
    }

    // 2. phone: Limpeza e validação MAIS RIGOROSA
    let cleanPhone = phone ? phone.replace(/\D/g, '') : ''; // Remove não-dígitos
    // Se o telefone for muito curto, preenche com um DDD/DDI padrão e um número fictício para alcançar o mínimo de 12
    if (cleanPhone.length < 12) {
        // Exemplo: se for 9 dígitos (só número), adiciona 5511 (Brasil, SP)
        if (cleanPhone.length === 9) {
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 11) { // 55DD + 9 dígitos (com 9 na frente)
             cleanPhone = `55${cleanPhone}`;
        } else if (cleanPhone.length < 10) { // Se for muito curto, usa um default completo
            cleanPhone = "5511987654321"; // Telefone default válido com 13 caracteres
        }
    }
    // Garante que não exceda 13 caracteres após as manipulações
    cleanPhone = cleanPhone.substring(0, 13);


    // 3. offer: SEMPRE enviar um objeto 'offer', mesmo que vazio ou com valores padrão
    let offerPayload = {
        id: offer_id || "", // Pode ser vazio se não houver ID real
        name: offer_name || "", // Pode ser vazio se não houver nome real
        discount_price: (discount_price !== null && discount_price !== undefined) ? Math.round(parseFloat(discount_price) * 100) : 0, // 0 se não houver desconto
        quantity: quantity || 1
    };
    // Se não há offer_id ou offer_name, mas o discount_price é 0, faz mais sentido
    // enviar um objeto offer com id e name vazios, mas sem discount_price
    if (!offer_id && !offer_name && offerPayload.discount_price === 0) {
        offerPayload = null; // Ou remova esta linha se a BuckPay realmente sempre espera um objeto
                              // A mensagem "Expected object, received null" indica que ela *sempre* quer o objeto
                              // Então, vamos manter o objeto com valores padrão, ou você pode remover esta linha `if (...) { offerPayload = null; }`
                              // Se você tem certeza de que nunca terá uma oferta, pode simplificar para:
                              // offerPayload = { id: "", name: "", discount_price: 0, quantity: 0 };
    }
    // REVISÃO: Mantenha sempre o objeto, mesmo que vazio, para satisfazer "Expected object, received null"
    // A única exceção é se "discount_price" for o gatilho. O erro é em "offer", não em "discount_price".
    // Então, se não há oferta, o objeto `offer` deve ser `null` ou um objeto com campos padrão.
    // Pelo erro, ele quer um objeto. Então, se `offer_id` e `offer_name` são nulos,
    // o `offerPayload` ainda precisa ser um objeto.
    // Vamos garantir que `offerPayload` seja SEMPRE um objeto se `offer_id` ou `offer_name` existir,
    // caso contrário, um objeto vazio mas existente.
    if (!offer_id && !offer_name && (discount_price === null || discount_price === undefined)) {
        offerPayload = null; // Se não tem ID, nome E preço, então não é uma oferta de fato
                             // No entanto, o erro 'Expected object, received null' sugere que mesmo assim
                             // ele quer um objeto vazio. Vamos tentar enviar um objeto vazio aqui se não houver dados.
        offerPayload = { id: "", name: "", discount_price: 0, quantity: 0 }; // Envia um objeto vazio para satisfazer
    } else {
         // Se houver algum dado de oferta, preenche normalmente
         offerPayload = {
            id: offer_id || "default_offer_id",
            name: offer_name || "Oferta Padrão",
            discount_price: (discount_price !== null && discount_price !== undefined) ? Math.round(parseFloat(discount_price) * 100) : 0,
            quantity: quantity || 1
        };
    }


    // 4. tracking: Mapeando e GARANTINDO campos obrigatórios
    let buckpayTracking = {};
    if (tracking) {
        // A BuckPay explicitamente pediu 'utm_source', 'utm_medium', 'utm_campaign'.
        // Vamos usar esses nomes diretamente e garantir que existam.
        buckpayTracking.utm_source = tracking.utm_source || 'direct'; // Default para 'direct'
        buckpayTracking.utm_medium = tracking.utm_medium || 'website'; // Default para 'website'
        buckpayTracking.utm_campaign = tracking.utm_campaign || 'no_campaign'; // Default para 'no_campaign'

        // Outros campos de tracking que você usa e que a BuckPay pode suportar (ou ignorar)
        // Mapeie os seus "xcod", "sck", "cid" para os nomes que a BuckPay espera,
        // ou inclua-os diretamente se a BuckPay aceitar nomes arbitrários (menos comum).
        // Se ela tem campos específicos para eles, como 'ref' e 'sck', você precisa mapear.
        // Pelo erro anterior, parecia que 'ref' e 'sck' eram obrigatórios no tracking.
        // Vamos tentar reintroduzir eles com valores padrão fortes.
        buckpayTracking.ref = tracking.cid || externalId; // 'ref' pode ser seu CID ou externalId
        buckpayTracking.sck = tracking.sck || 'no_sck_value'; // 'sck' do frontend
        buckbody.xcod = tracking.xcod || 'no_xcod_value'; // Seu xcod original
        buckpayTracking.utm_term = tracking.utm_term || '';
        buckpayTracking.utm_content = tracking.utm_content || '';
    } else {
        // Se tracking for nulo, ainda garanta os obrigatórios com defaults
        buckpayTracking = {
            utm_source: 'direct',
            utm_medium: 'website',
            utm_campaign: 'no_campaign',
            ref: externalId, // Padrão
            sck: 'no_sck_value', // Padrão
            utm_term: '',
            utm_content: '',
            xcod: '', // Padrão
        };
    }


    const payload = {
        external_id: externalId,
        payment_method: "pix",
        amount: amountInCents, // Usar o valor corrigido
        buyer: {
            name: name,
            email: email,
            document: document,
            phone: cleanPhone // Usar o telefone limpo e corrigido
        },
        product: product_id && product_name ? { id: product_id, name: product_name } : null,
        offer: offerPayload, // Usar o payload de oferta corrigido
        tracking: buckpayTracking // Usar o tracking mapeado e garantido
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
            client = await pool.connect();
            try {
                const insertQuery = `
                    INSERT INTO transactions (external_id, status, amount, buyer_email, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, NOW(), NOW())
                    RETURNING id;
                `;
                // Salva o 'amount' original que veio do frontend (R$) para referência, se quiser.
                // Ou salva 'amountInCents' se for o valor em centavos que você quer registrar.
                // Estou mantendo o 'amount' original por agora.
                const resDb = await client.query(insertQuery, [externalId, data.data.status, amount, email]);
                console.log(`Transação ${externalId} salva no DB com ID interno: ${resDb.rows[0].id}`);
            } catch (dbError) {
                console.error(`❌ Erro ao salvar transação ${externalId} no DB:`, dbError);
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
                transactionId: externalId
            });
        } else {
            console.error("Resposta inesperada da BuckPay (sem PIX):", data);
            res.status(500).json({ success: false, error: "Resposta inesperada da BuckPay (PIX não gerado)." });
        }

    } catch (error) {
        console.error("Erro ao processar criação de pagamento (requisição BuckPay ou DB):", error);
        res.status(500).json({ error: "Erro interno ao criar pagamento." });
    }
});

app.post("/webhook/buckpay", async (req, res) => {
    const event = req.body.event;
    const data = req.body.data;

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${data.status}', ID BuckPay: '${data.id}', External ID: '${data.external_id}'`);

    if (event && data && data.external_id && data.status) {
        const externalId = data.external_id;
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
                console.warn(`⚠️ Webhook para externalId ${externalId} recebido, mas transação não encontrada no DB para atualizar.`);
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
        console.warn("⚠️ Webhook recebido com dados inválidos ou evento não esperado.");
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