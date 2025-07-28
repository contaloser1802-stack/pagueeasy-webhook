import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";

// CONFIG UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = "mH3Y79bB6pQKd3aJavkilhVTETVQyDebOhb7"; // <-- Coloque o token real da UTMify

if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render.");
    process.exit(1);
}

// --- ARMAZENAMENTO TEMPORÁRIO EM MEMÓRIA ---
// Chave: externalId
// Valor: {
//   createdAt: Date,
//   buckpayId: string, // ID interno da BuckPay
//   status: string (e.g., 'pending', 'paid', 'expired', 'refunded')
// }
const pendingTransactions = new Map();
const TRANSACTION_LIFETIME_MINUTES = 35; // Pix expira em 30min na BuckPay. Guardar por 35-40min para garantir o webhook.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Rodar limpeza a cada 5 minutos

// Função para limpar transações expiradas ou finalizadas da memória
function cleanupTransactionsInMemory() {
    const now = new Date();
    for (const [externalId, transactionInfo] of pendingTransactions.entries()) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        // Se a transação está em um status final (paga, reembolsada, cancelada/expirada)
        // ou se passou do tempo de vida que decidimos manter na memória, remove.
        // Isso é para lidar com o webhook que informa 'canceled' ou 'expired' após 30min.
        if (transactionInfo.status !== 'pending' || elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES) {
             pendingTransactions.delete(externalId);
             console.log(`🧹 Transação ${externalId} (${transactionInfo.status || 'sem status final'}) removida da memória após ${elapsedTimeMinutes.toFixed(0)} minutos.`);
        }
    }
}

// Inicia o processo de limpeza periódica
setInterval(cleanupTransactionsInMemory, CLEANUP_INTERVAL_MS);
console.log(`Limpeza de transações agendada a cada ${CLEANUP_INTERVAL_MS / 1000 / 60} minutos.`);
// --- FIM DO ARMAZENAMENTO TEMPORÁRIO ---


// Middlewares
app.use(cors({
    origin: 'https://freefirereward.site', // Verifique se este domínio está correto para seu frontend
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    if (cleanPhone.length > 0 && !cleanPhone.startsWith('55')) {
        if (cleanPhone.length === 9) {
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 10 || cleanPhone.length === 11) {
            cleanPhone = `55${cleanPhone}`;
        }
    }
    if (cleanPhone.length < 12) {
        cleanPhone = "5511987654321";
    }
    cleanPhone = cleanPhone.substring(0, 13);


    let offerPayload = null;
    if (!offer_id && !offer_name && (discount_price === null || discount_price === undefined)) {
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
        const response = await fetch(BUCK_PAY_CREATE_TRANSACTION_URL, {
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
            // --- NOVO: Armazena a transação em memória ---
            pendingTransactions.set(externalId, {
                createdAt: new Date(),
                buckpayId: data.data.id, // Armazena o ID da BuckPay
                status: 'pending' // Inicialmente pendente
            });
            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);
            // --- FIM DO NOVO BLOCO ---

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

    let externalIdFromWebhook = null;
    if (data && data.tracking) {
        if (data.tracking.ref) {
            externalIdFromWebhook = data.tracking.ref;
        } else if (data.tracking.utm && data.tracking.utm.id) {
            externalIdFromWebhook = data.tracking.utm.id;
        }
    }

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${data.status}', ID BuckPay: '${data.id}', External ID: '${externalIdFromWebhook}'`);

    // --- ATUALIZADO: Atualiza o status da transação em memória e processa se pago ---
    if (externalIdFromWebhook) {
        const transactionInfo = pendingTransactions.get(externalIdFromWebhook);
        if (transactionInfo) {
            transactionInfo.status = data.status; // Atualiza o status recebido do webhook
            transactionInfo.buckpayId = data.id; // Garante que o ID da BuckPay está salvo

            console.log(`Status da transação ${externalIdFromWebhook} atualizado em memória para '${data.status}'.`);

            // --- Lógica para UTMify apenas se o pagamento for aprovado ---
            if (data.status === 'paid') {
                console.log(`🎉 Pagamento ${externalIdFromWebhook} APROVADO pela BuckPay via webhook! Enviando para UTMify.`);

                const customer = data.buyer || {};
                const totalValue = data.amount; // Valor total em centavos

                const bodyForUTMify = {
                    orderId: externalIdFromWebhook,
                    platform: "FreeFireCheckout",
                    paymentMethod: "pix",
                    status: "paid",
                    createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
                    approvedDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
                    customer: {
                        name: customer?.name || "Cliente",
                        email: customer?.email || "cliente@teste.com",
                        phone: customer?.phone || "",
                        document: customer?.document || "",
                        country: "BR"
                    },
                    products: [
                        {
                            id: data.product?.id || "recarga-ff",
                            name: data.product?.name || "Recarga Free Fire",
                            quantity: data.offer?.quantity || 1,
                            priceInCents: totalValue || 0,
                            planId: data.offer?.id || "basic",
                            planName: data.offer?.name || "Plano Básico"
                        }
                    ],
                    commission: {
                        totalPriceInCents: totalValue || 0,
                        gatewayFeeInCents: data.fees?.gateway_fee || 0,
                        userCommissionInCents: totalValue - (data.fees?.gateway_fee || 0)
                    },
                    trackingParameters: {
                        utm_campaign: data.tracking?.utm_campaign || "",
                        utm_content: data.tracking?.utm_content || "",
                        utm_medium: data.tracking?.utm_medium || "",
                        utm_source: data.tracking?.utm_source || "",
                        utm_term: data.tracking?.utm_term || ""
                    },
                    isTest: false
                };

                try {
                    const responseUTMify = await fetch(UTMIFY_URL, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-api-token": UTMIFY_TOKEN
                        },
                        body: JSON.stringify(bodyForUTMify)
                    });

                    const resultUTMify = await responseUTMify.json();
                    console.log("UTMify resposta:", resultUTMify);
                } catch (utmifyError) {
                    console.error("Erro ao enviar dados para UTMify:", utmifyError);
                }
            } else if (data.status === 'refunded' || data.status === 'canceled' || data.status === 'expired') {
                console.log(`💔 Pagamento ${externalIdFromWebhook} status final: ${data.status}. Nenhuma ação na UTMify.`);
            }

        } else {
            console.warn(`Webhook para externalId ${externalIdFromWebhook} recebido, mas transação não encontrada em memória. Pode ser um reinício do servidor ou transação antiga.`);
        }
    }
    // --- FIM DA ATUALIZAÇÃO ---

    res.status(200).send("Webhook recebido com sucesso!");
});

// Rota de Consulta de Status para o Frontend (Lendo APENAS da MEMÓRIA)
app.get("/check-order-status", async (req, res) => {
    const externalId = req.query.id;

    if (!externalId) {
        return res.status(400).json({ error: "ID externo da transação não fornecido." });
    }

    const transactionInfo = pendingTransactions.get(externalId);
    const now = new Date();

    if (transactionInfo) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        // Se a transação estiver pendente e o tempo de vida do Pix (30min) já passou,
        // marca como expirada *em memória* e informa o frontend.
        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > 30) {
            transactionInfo.status = 'expired'; // Marca como expirada
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
            return res.status(200).json({ success: true, status: 'expired' });
        }

        // Retorna o status atual da transação em memória
        console.log(`Retornando status em memória para ${externalId}: ${transactionInfo.status}`);
        return res.status(200).json({ success: true, status: transactionInfo.status });

    } else {
        // Se a transação não foi encontrada em memória, pode ser que:
        // 1. Ela já foi paga/expirada e removida pela limpeza agendada.
        // 2. O servidor reiniciou e o Map foi limpo.
        // Em ambos os casos, não temos como saber o status sem um DB.
        console.warn(`Consulta para externalId ${externalId}, mas transação NÃO ENCONTRADA EM MEMÓRIA.`);
        return res.status(200).json({ success: true, status: 'not_found_or_expired' });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));