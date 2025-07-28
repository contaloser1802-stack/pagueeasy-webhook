import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // 'node-fetch' é uma dependência que precisa ser instalada (npm install node-fetch)

const app = express();

const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
// AJUSTE: A URL base da API BuckPay para criação de transações é /v1/transactions
// A consulta de status usa /v1/transactions/external_id/:external_id
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";
const BUCK_PAY_CHECK_STATUS_BASE_URL = "https://api.realtechdev.com.br/v1/transactions/external_id"; // Nova base para consulta por external_id

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
    // Corrigindo a lógica do telefone para garantir 55 na frente e 10-11 dígitos após
    if (cleanPhone.length > 0 && !cleanPhone.startsWith('55')) {
        // Assume que se não começa com 55, é um número local. Tenta adicionar 55 e DDD
        // Exemplo: se for 9 dígitos (9XXXX-YYYY), assume DDD 11
        if (cleanPhone.length === 9) { // Ex: 987654321
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 10 || cleanPhone.length === 11) { // Ex: 11987654321 ou 1187654321
            cleanPhone = `55${cleanPhone}`;
        }
    }
    // Caso ainda esteja curto ou seja um número totalmente inválido, usa fallback
    if (cleanPhone.length < 12) { // 55 + DDD (2 digitos) + Telefone (8 ou 9 digitos) = 12 ou 13
        cleanPhone = "5511987654321"; // Telefone padrão de fallback
    }
    cleanPhone = cleanPhone.substring(0, 13); // Garante que não exceda o limite de 13 (55DD9XXXXXXXX)


    let offerPayload = null;
    if (!offer_id && !offer_name && (discount_price === null || discount_price === undefined)) {
        // Se nenhuma informação de oferta foi fornecida, envia null ou um objeto vazio conforme a necessidade da API Buckpay.
        // A documentação diz "Objeto ou null" para 'offer', mas as sub-propriedades são "Sim String ou null".
        // Para evitar erros de validação na Buckpay, é mais seguro enviar null se não houver dados válidos.
        offerPayload = null;
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
    // É importante que o utm_id e ref contenham o externalId para que você possa recuperá-lo no webhook
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
        const response = await fetch(BUCK_PAY_CREATE_TRANSACTION_URL, { // Usando a URL específica para criação
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

// Rota de Webhook da BuckPay
app.post("/webhook/buckpay", async (req, res) => {
    const event = req.body.event;
    const data = req.body.data;

    // --- CORREÇÃO PRINCIPAL AQUI ---
    // O external_id no webhook não vem como 'data.external_id' diretamente.
    // Ele vem dentro do objeto 'tracking', como 'tracking.ref' ou 'tracking.utm.id'.
    let externalIdFromWebhook = null;
    if (data && data.tracking) {
        if (data.tracking.ref) {
            externalIdFromWebhook = data.tracking.ref;
        } else if (data.tracking.utm && data.tracking.utm.id) {
            externalIdFromWebhook = data.tracking.utm.id;
        }
    }
    // --- FIM DA CORREÇÃO ---

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${data.status}', ID BuckPay: '${data.id}', External ID: '${externalIdFromWebhook}'`);

    // **IMPORTANTE:** Se você planeja persistir o status da transação em um banco de dados
    // em algum momento, este é o lugar onde você usaria o `externalIdFromWebhook`
    // para encontrar a transação correspondente no seu DB e atualizar o status (`data.status`).

    res.status(200).send("Webhook recebido com sucesso!");
});

// NOVA ROTA: Consulta o status da transação diretamente na BuckPay
app.get("/check-order-status", async (req, res) => {
    const externalId = req.query.id; // O frontend deve passar o `externalId` que você gerou

    if (!externalId) {
        return res.status(400).json({ error: "ID externo da transação não fornecido." });
    }

    try {
        // --- CORREÇÃO PRINCIPAL AQUI ---
        // Construindo a URL de consulta de status conforme a documentação:
        // GET /v1/transactions/external_id/:external_id
        const BUCK_PAY_STATUS_URL = `${BUCK_PAY_CHECK_STATUS_BASE_URL}/${externalId}`;
        // --- FIM DA CORREÇÃO ---

        console.log(`Tentando consultar status na BuckPay na URL: ${BUCK_PAY_STATUS_URL}`);

        const response = await fetch(BUCK_PAY_STATUS_URL, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BUCK_PAY_API_KEY}`,
                "User-Agent": "Buckpay API Status Check" // Diferenciando o User-Agent se desejar
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
        // O retorno da consulta GET /v1/transactions/external_id/:external_id também tem o status dentro de 'data'
        const statusFromBuckPay = data.data?.status || 'unknown';

        console.log(`Status BuckPay para ${externalId}:`, statusFromBuckPay);

        res.status(200).json({ success: true, status: statusFromBuckPay });

    } catch (error) {
        console.error("Erro ao consultar status da BuckPay:", error);
        res.status(500).json({ success: false, error: "Erro interno ao consultar status." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));