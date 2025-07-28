import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// --- CONFIGURAÇÕES ---
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
// Pix expira em 30min na BuckPay. Guardamos por um pouco mais para garantir que o webhook chegue
// e a informação seja útil para o frontend durante a janela de pagamento.
const TRANSACTION_LIFETIME_MINUTES = 35;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Rodar limpeza a cada 5 minutos

// Função para limpar transações expiradas ou finalizadas da memória
function cleanupTransactionsInMemory() {
    const now = new Date();
    for (const [externalId, transactionInfo] of pendingTransactions.entries()) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        // Remove transações que já não estão mais pendentes ou que passaram do tempo de vida na memória.
        // O status "pending" é o que esperamos monitorar. Qualquer outro status é considerado final para este fim.
        if (transactionInfo.status !== 'pending' || elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES) {
             pendingTransactions.delete(externalId);
             console.log(`🧹 Transação ${externalId} (status: ${transactionInfo.status || 'sem status final'}) removida da memória após ${elapsedTimeMinutes.toFixed(0)} minutos.`);
        }
    }
}

// Inicia o processo de limpeza periódica ao iniciar o servidor
setInterval(cleanupTransactionsInMemory, CLEANUP_INTERVAL_MS);
console.log(`Limpeza de transações agendada a cada ${CLEANUP_INTERVAL_MS / 1000 / 60} minutos.`);
// --- FIM DO ARMAZENAMENTO TEMPORÁRIO ---


// --- MIDDLEWARES ---
app.use(cors({
    origin: 'https://freefirereward.site', // IMPORTANTE: Verifique se este domínio está correto para seu frontend
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json()); // Para parsing de JSON no body das requisições
app.use(express.urlencoded({ extended: true })); // Para parsing de URL-encoded no body (se necessário)


// --- ROTAS ---

// Rota para testar se o servidor está online
app.get("/", (req, res) => {
    res.send("Servidor PagueEasy está online!");
});

// Rota para obter o IP do servidor (útil para configurar webhooks)
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

// Rota para criar transação PIX via BuckPay
app.post("/create-payment", async (req, res) => {
    // Desestruturação dos dados da requisição do frontend
    const { amount, email, name, document, phone, product_id, product_name, offer_id, offer_name, discount_price, quantity, tracking } = req.body;

    // Validação básica dos dados obrigatórios
    if (!amount || !email || !name) {
        return res.status(400).json({ error: "Dados obrigatórios (amount, email, name) estão faltando." });
    }

    // Geração de um ID externo único para rastreamento interno e no webhook
    const externalId = `order_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    console.log(`Gerando pagamento para ${email} com externalId: ${externalId}`);

    // Conversão do valor para centavos e validação mínima (R$5,00 = 500 centavos)
    const amountInCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountInCents) || amountInCents < 500) {
        return res.status(400).json({ error: "Valor de pagamento inválido ou abaixo do mínimo de R$5,00." });
    }

    // Normalização e formatação do número de telefone
    let cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    if (cleanPhone.length > 0 && !cleanPhone.startsWith('55')) {
        if (cleanPhone.length === 9) { // Ex: 912345678 (sem DDD) -> assume DDD 11
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 10 || cleanPhone.length === 11) { // Ex: 11912345678 (com DDD)
            cleanPhone = `55${cleanPhone}`;
        }
    }
    // Caso o telefone ainda seja inválido ou vazio, usa um placeholder
    if (cleanPhone.length < 12) {
        cleanPhone = "5511987654321"; // Telefone genérico para evitar erro na API da BuckPay
    }
    cleanPhone = cleanPhone.substring(0, 13); // Garante o tamanho máximo para a API

    // Montagem do payload da oferta, se houver
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

    // Montagem dos parâmetros de rastreamento para a BuckPay
    let buckpayTracking = {};
    buckpayTracking.utm_source = tracking?.utm_source || 'direct';
    buckpayTracking.utm_medium = tracking?.utm_medium || 'website';
    buckpayTracking.utm_campaign = tracking?.utm_campaign || 'no_campaign';
    buckpayTracking.src = tracking?.utm_source || 'direct';
    buckpayTracking.utm_id = tracking?.xcod || tracking?.cid || externalId;
    buckpayTracking.ref = tracking?.cid || externalId; // ESSENCIAL: BuckPay retorna 'ref' no webhook
    buckpayTracking.sck = tracking?.sck || 'no_sck_value';
    buckpayTracking.utm_term = tracking?.utm_term || '';
    buckpayTracking.utm_content = tracking?.utm_content || '';

    // Corpo final da requisição para a BuckPay
    const payload = {
        external_id: externalId, // Usado para identificar a transação no seu sistema
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
        // Faz a requisição para a API da BuckPay
        const response = await fetch(BUCK_PAY_CREATE_TRANSACTION_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BUCK_PAY_API_KEY}`,
                "User-Agent": "Buckpay API" // Boa prática para identificar sua aplicação
            },
            body: JSON.stringify(payload)
        });

        // Trata respostas de erro da BuckPay
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

        // Verifica se o Pix foi gerado com sucesso na resposta da BuckPay
        if (data.data && data.data.pix && data.data.pix.qrcode_base64) {
            // --- NOVO: Armazena a transação em memória após criar o Pix ---
            pendingTransactions.set(externalId, {
                createdAt: new Date(), // Registra o momento da criação
                buckpayId: data.data.id, // Armazena o ID interno da BuckPay para referência
                status: 'pending' // Define o status inicial como pendente
            });
            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);
            // --- FIM DO NOVO BLOCO ---

            // Retorna os dados do Pix e o externalId para o frontend
            res.status(200).json({
                pix: {
                    code: data.data.pix.code,
                    qrcode_base64: data.data.pix.qrcode_base64
                },
                transactionId: externalId // Retorna o externalId para o frontend usar na consulta de status
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

// Rota de Webhook da BuckPay (recebe notificações de status da BuckPay)
app.post("/webhook/buckpay", async (req, res) => {
    // Pega o evento e os dados da transação do corpo do webhook
    const event = req.body.event;
    const data = req.body.data;

    // Extrai o externalId do webhook, que deve ser o mesmo que enviamos na criação
    let externalIdFromWebhook = null;
    if (data && data.tracking) {
        if (data.tracking.ref) { // BuckPay normalmente usa 'ref' no tracking para external_id
            externalIdFromWebhook = data.tracking.ref;
        } else if (data.tracking.utm && data.tracking.utm.id) {
            externalIdFromWebhook = data.tracking.utm.id;
        }
    }

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${data.status}', ID BuckPay: '${data.id}', External ID: '${externalIdFromWebhook}'`);

    // --- ATUALIZAÇÃO DO STATUS EM MEMÓRIA E PROCESSAMENTO ---
    if (externalIdFromWebhook) {
        const transactionInfo = pendingTransactions.get(externalIdFromWebhook);

        if (transactionInfo) {
            // Atualiza o status da transação em memória com o que veio do webhook
            transactionInfo.status = data.status;
            transactionInfo.buckpayId = data.id; // Garante que o ID da BuckPay está salvo

            console.log(`Status da transação ${externalIdFromWebhook} atualizado em memória para '${data.status}'.`);

            // --- Lógica para UTMify apenas se o pagamento for aprovado ('paid') ---
            if (data.status === 'paid') {
                console.log(`🎉 Pagamento ${externalIdFromWebhook} APROVADO pela BuckPay via webhook! Enviando para UTMify.`);

                const customer = data.buyer || {};
                const totalValue = data.amount; // Valor total em centavos

                // Monta o corpo da requisição para a UTMify
                const bodyForUTMify = {
                    orderId: externalIdFromWebhook, // ID do seu pedido
                    platform: "FreeFireCheckout",
                    paymentMethod: "pix",
                    status: "paid",
                    createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '), // Data e hora de criação
                    approvedDate: new Date().toISOString().slice(0, 19).replace('T', ' '), // Data e hora da aprovação
                    customer: {
                        name: customer?.name || "Cliente",
                        email: customer?.email || "cliente@teste.com",
                        phone: customer?.phone || "",
                        document: customer?.document || "",
                        country: "BR"
                    },
                    products: [
                        {
                            id: data.product?.id || "recarga-ff", // ID do produto do webhook
                            name: data.product?.name || "Recarga Free Fire",
                            quantity: data.offer?.quantity || 1,
                            priceInCents: totalValue || 0,
                            planId: data.offer?.id || "basic", // ID do plano/oferta do webhook
                            planName: data.offer?.name || "Plano Básico"
                        }
                    ],
                    commission: {
                        totalPriceInCents: totalValue || 0,
                        gatewayFeeInCents: data.fees?.gateway_fee || 0, // Ajuste para o campo correto de taxas da BuckPay
                        userCommissionInCents: totalValue - (data.fees?.gateway_fee || 0) // Exemplo de cálculo da comissão
                    },
                    trackingParameters: {
                        utm_campaign: data.tracking?.utm_campaign || "",
                        utm_content: data.tracking?.utm_content || "",
                        utm_medium: data.tracking?.utm_medium || "",
                        utm_source: data.tracking?.utm_source || "",
                        utm_term: data.tracking?.utm_term || ""
                    },
                    isTest: false // Ajuste se a BuckPay indicar modo de teste no webhook
                };

                // Envia os dados para a UTMify
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
                console.log(`💔 Pagamento ${externalIdFromWebhook} status final: ${data.status}. Nenhuma ação adicional para UTMify.`);
                // Adicione aqui lógica para estorno, cancelamento ou expiração se necessário
            }

        } else {
            console.warn(`Webhook para externalId ${externalIdFromWebhook} recebido, mas transação não encontrada em memória. Isso pode acontecer se o servidor reiniciou ou se a transação foi criada há muito tempo e já foi limpa.`);
        }
    }
    // --- FIM DA ATUALIZAÇÃO ---

    // Sempre responda 200 OK para o webhook indicar que você o recebeu com sucesso
    res.status(200).send("Webhook recebido com sucesso!");
});

// Rota de Consulta de Status para o Frontend (Lendo APENAS do Map em Memória)
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
        // marcamos como 'expired' em memória e informamos ao frontend.
        // O status 'expired' também pode vir via webhook da BuckPay, mas esta lógica
        // garante que o frontend receba essa informação mesmo sem o webhook imediato.
        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > 30) {
            transactionInfo.status = 'expired'; // Marca como expirada para o controle em memória
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
            return res.status(200).json({ success: true, status: 'expired' });
        }

        // Retorna o status atual da transação em memória para o frontend
        console.log(`Retornando status em memória para ${externalId}: ${transactionInfo.status}`);
        return res.status(200).json({ success: true, status: transactionInfo.status });

    } else {
        // Se a transação não foi encontrada em memória, pode ser que:
        // 1. Ela já foi paga/expirada e foi removida pela função de limpeza.
        // 2. O servidor reiniciou e o Map foi limpo, perdendo o registro.
        // Em ambos os casos, não temos mais o status para informar o frontend.
        console.warn(`Consulta para externalId ${externalId}, mas transação NÃO ENCONTRADA EM MEMÓRIA.`);
        // Informa um status genérico para que o frontend possa lidar (ex: sugerir novo Pix)
        return res.status(200).json({ success: true, status: 'not_found_or_expired' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000; // Usa a porta definida pelo ambiente (Render) ou 3000
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));