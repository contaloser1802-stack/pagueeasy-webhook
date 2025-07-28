import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";
// DATABASE_URL não será mais usado, mas pode permanecer na Environment do Render.

if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render.");
    process.exit(1);
}

// Middlewares
app.use(cors({
    origin: 'https://freefirereward.site', // Verifique se este domínio está correto para seu frontend
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

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
            cleanPhone = "5511987654321"; // Telefone padrão de fallback
        }
    }
    cleanPhone = cleanPhone.substring(0, 13); // Garante que não exceda o limite

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
    buckpayTracking.src = tracking?.utm_source || 'direct';
    buckpayTracking.utm_id = tracking?.xcod || tracking?.cid || externalId;
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
            res.status(200).json({
                pix: {
                    code: data.data.pix.code,
                    qrcode_base64: data.data.pix.qrcode_base64
                },
                transactionId: externalId // Retorna o externalId para o frontend usar na consulta
            });
        } else {
            console.error("Resposta inesperada da BuckPay (sem PIX):", data);
            res.status(500).json({ success: false, error: "Resposta inesperada da BuckPay (PIX não gerado)." });
        }

    } catch (error) {
        console.error("Erro ao processar criação de pagamento (requisição BuckPay):", error);
        res.status(500).json({ success: false, error: "Erro interno ao criar pagamento." });
    }
});

app.post("/webhook/buckpay", async (req, res) => {
    const event = req.body.event;
    const data = req.body.data;

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${data.status}', ID BuckPay: '${data.id}', External ID: '${data.external_id}'`);

    // Com esta solução, o backend APENAS LOGA o webhook,
    // pois não há DB para persistir o status.
    // O frontend é quem fará a checagem ativa.

    res.status(200).send("Webhook recebido com sucesso!");
});

// NOVA ROTA: Consulta o status da transação diretamente na BuckPay
app.get("/check-order-status", async (req, res) => {
    const externalId = req.query.id; // Ou `req.query.buckpayId` se você passar o ID da BuckPay

    if (!externalId) {
        return res.status(400).json({ error: "ID externo da transação não fornecido." });
    }

    try {
        // **IMPORTANTE:** O endpoint e o método para consultar o status na BuckPay
        // podem variar. Você PRECISA verificar a documentação da API da BuckPay
        // para saber qual é o endpoint correto para consultar status de uma transação.
        // Vou usar um exemplo genérico aqui:
        const BUCK_PAY_STATUS_URL = `${BUCK_PAY_URL}/${externalId}`; // Exemplo: GET /v1/transactions/{id}
        // OU: const BUCK_PAY_STATUS_URL = `${BUCK_PAY_URL}?external_id=${externalId}`; // Exemplo: GET /v1/transactions?external_id={external_id}

        const response = await fetch(BUCK_PAY_STATUS_URL, {
            method: "GET", // ou "POST" se a API BuckPay exigir para consulta
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BUCK_PAY_API_KEY}`,
                "User-Agent": "Buckpay API Status Check"
            }
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            console.error(`Erro ao consultar status na BuckPay (HTTP status ${response.status}):`, errorDetails);
            return res.status(response.status).json({
                success: false,
                error: "Erro ao consultar status na BuckPay.",
                details: errorDetails
            });
        }

        const data = await response.json();
        console.log(`Status BuckPay para ${externalId}:`, data.data?.status);

        // Adapte 'data.data?.status' para o caminho correto do status na resposta da BuckPay
        // Por exemplo, pode ser data.status, data.transaction.status, etc.
        const statusFromBuckPay = data.data?.status || 'unknown'; // Ajuste este caminho

        res.status(200).json({ success: true, status: statusFromBuckPay });

    } catch (error) {
        console.error("Erro ao consultar status da BuckPay:", error);
        res.status(500).json({ success: false, error: "Erro interno ao consultar status." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));