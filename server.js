import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// --- CONFIGURAÇÕES ---
const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";

// CONFIG UTMify
// RECOMENDADO: Use process.env.UTMIFY_TOKEN no Render para segurança
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN || "omtunj6CIgiQMUsIs8x2aX9nhEG7uGsHTbww"; // Token de exemplo, substitua pelo seu token REAL no Render ou aqui.

if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render.");
    process.exit(1);
}
if (!UTMIFY_TOKEN) {
    console.warn("Aviso: Variável de ambiente UTMIFY_TOKEN não configurada. Usando token hardcoded (não recomendado em produção).");
}

// --- ARMAZENAMENTO TEMPORÁRIO EM MEMÓRIA ---
// Chave: externalId
// Valor: {
//   createdAt: Date,
//   buckpayId: string, // ID interno da BuckPay
//   status: string (e.g., 'pending', 'paid', 'expired', 'refunded')
//   tracking: object, // Armazenar os parâmetros de tracking
//   customer: object,
//   product: object,
//   offer: object,
//   amountInCents: number,
//   gatewayFee: number // NOVO: Para armazenar a taxa de gateway
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

// --- FUNÇÃO PARA ENVIAR PARA UTMify (Refatorada para reuso) ---
async function sendToUTMify(orderData, externalId, trackingParameters, status, customerData, productData, offerData, gatewayFee) {
    console.log(`[UTMify] Enviando status '${status}' para orderId: ${externalId}`);

    // Garante que commission.userCommissionInCents seja pelo menos 1 centavo para 'paid'
    let userCommission = orderData.amountInCents - (gatewayFee || 0);
    if (status === 'paid' && orderData.amountInCents > 0 && userCommission <= 0) {
        userCommission = 1;
    }

    const bodyForUTMify = {
        orderId: externalId,
        platform: "FreeFireCheckout",
        paymentMethod: "pix",
        status: status,
        createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        // CORREÇÃO AQUI: Enviar null para approvedDate se não for 'paid', e a data se for 'paid'
        approvedDate: status === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
        customer: {
            name: customerData?.name || "Cliente",
            email: customerData?.email || "cliente@teste.com",
            phone: customerData?.phone || "",
            document: customerData?.document || "",
            country: "BR"
        },
        products: [
            {
                id: productData?.id || "recarga-ff",
                name: productData?.name || "Recarga Free Fire",
                quantity: offerData?.quantity || 1,
                priceInCents: orderData.amountInCents || 0,
                planId: offerData?.id || "basic",
                planName: offerData?.name || "Plano Básico"
            }
        ],
        commission: {
            totalPriceInCents: orderData.amountInCents || 0,
            gatewayFeeInCents: gatewayFee,
            userCommissionInCents: userCommission
        },
        trackingParameters: {
            utm_campaign: trackingParameters?.utm_campaign || "",
            utm_content: trackingParameters?.utm_content || "",
            utm_medium: trackingParameters?.utm_medium || "",
            utm_source: trackingParameters?.utm_source || "",
            utm_term: trackingParameters?.utm_term || "",
            cid: trackingParameters?.cid || externalId // Certifica que o CID está sendo enviado
        },
        isTest: false
    };

    console.log("[UTMify] Payload enviado:", JSON.stringify(bodyForUTMify, null, 2)); // Adicionei para depuração

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
        if (!responseUTMify.ok) {
            console.error(`[UTMify Error] Status: ${responseUTMify.status}, Resposta:`, resultUTMify);
        } else {
            console.log("[UTMify] Resposta:", resultUTMify);
        }
    } catch (utmifyError) {
        console.error("[UTMify Error] Erro ao enviar dados para UTMify:", utmifyError);
    }
}
// --- FIM DA FUNÇÃO UTMify ---


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
    // Garante um telefone padrão se não for fornecido ou for muito curto
    if (cleanPhone.length < 12) { // 55 + DDD (2 digitos) + 8 ou 9 digitos
        cleanPhone = "5511987654321";
    }
    cleanPhone = cleanPhone.substring(0, 13); // Limita o tamanho para evitar problemas de validação externa

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
    buckpayTracking.ref = tracking?.cid || externalId; // Use 'ref' para o external_id
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
                "User-Agent": "Buckpay API" // Boa prática para identificação
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
            // Armazena a transação em memória, incluindo o gatewayFee que pode vir no webhook futuro
            pendingTransactions.set(externalId, {
                createdAt: new Date(),
                buckpayId: data.data.id,
                status: 'pending',
                tracking: tracking, // Armazena o tracking original do frontend
                customer: { name, email, document, phone: cleanPhone },
                product: product_id && product_name ? { id: product_id, name: product_name } : null,
                offer: offerPayload,
                amountInCents: amountInCents,
                gatewayFee: 0 // Inicializa com 0, será atualizado pelo webhook se vier com fee
            });
            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);

            // --- Enviar para UTMify com status "waiting_payment" ---
            await sendToUTMify(
                { amountInCents: amountInCents },
                externalId,
                tracking, // Passa o objeto de tracking original
                "waiting_payment", // Status para UTMify
                { name, email, document, phone: cleanPhone },
                product_id && product_name ? { id: product_id, name: product_name } : null,
                offerPayload,
                0 // Gateway fee é 0 para waiting_payment, será atualizado em 'paid'
            );

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
        console.error("Erro ao processar criação de pagamento (requisição BuckPay):", error);
        res.status(500).json({ success: false, error: "Erro interno ao criar pagamento." });
    }
});

// Rota de Webhook da BuckPay (recebe notificações de status da BuckPay)
app.post("/webhook/buckpay", async (req, res) => {
    const event = req.body.event;
    const data = req.body.data;

    let externalIdFromWebhook = null;
    // Tenta obter o externalId do webhook, dando preferência a 'ref' ou 'utm_id' no tracking
    if (data && data.tracking) {
        externalIdFromWebhook = data.tracking.ref || data.tracking.utm_id;
    }
    // Se não encontrar no tracking, tenta direto do campo external_id se existir (alguns webhooks BuckPay podem ter)
    if (!externalIdFromWebhook && data && data.external_id) {
        externalIdFromWebhook = data.external_id;
    }


    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${data.status}', ID BuckPay: '${data.id}', External ID: '${externalIdFromWebhook}'`);

    if (externalIdFromWebhook) {
        const transactionInfo = pendingTransactions.get(externalIdFromWebhook);

        // Caso a transação NÃO esteja em memória (servidor reiniciou, ou já foi limpa por tempo)
        if (!transactionInfo) {
            console.warn(`Webhook para externalId ${externalIdFromWebhook} recebido, mas transação NÃO ENCONTRADA EM MEMÓRIA.`);
            // Se for um status 'paid', mesmo sem estar em memória, tentar enviar para UTMify.
            // Isso é crucial para não perder vendas aprovadas se o servidor cair ou a transação expirar na memória antes do webhook 'paid'.
            if (data.status === 'paid') {
                console.warn(`Tentando enviar status 'paid' para UTMify mesmo sem encontrar transação em memória: ${externalIdFromWebhook}`);
                await sendToUTMify(
                    { amountInCents: data.amount }, // Usa amount do webhook
                    externalIdFromWebhook,
                    data.tracking, // Usa tracking do webhook
                    "paid",
                    data.buyer, // Usa buyer do webhook
                    data.product, // Usa product do webhook
                    data.offer, // Usa offer do webhook
                    data.fees?.gateway_fee || 0 // Usa gateway_fee do webhook
                );
            }
            // Retorna 200 OK para a BuckPay para evitar retransmissões do mesmo webhook
            return res.status(200).send("Webhook recebido com sucesso (transação não encontrada em memória, mas processado se pago).");
        }

        // Caso a transação ESTEJA em memória
        // Atualiza a informação de gatewayFee da transação em memória, caso ela venha em um webhook posterior
        if (data.fees?.gateway_fee !== undefined) {
            transactionInfo.gatewayFee = data.fees.gateway_fee;
        }

        // Só processa e envia para UTMify se o status da transação MUDOU
        if (transactionInfo.status !== data.status) {
            transactionInfo.status = data.status; // Atualiza o status em memória
            transactionInfo.buckpayId = data.id; // Garante o BuckPay ID

            // Atualiza outros dados em memória com os dados do webhook, que podem ser mais recentes
            transactionInfo.customer = data.buyer || transactionInfo.customer;
            transactionInfo.product = data.product || transactionInfo.product;
            transactionInfo.offer = data.offer || transactionInfo.offer;
            transactionInfo.amountInCents = data.amount || transactionInfo.amountInCents; // Atualiza valor se BuckPay enviar

            console.log(`Status da transação ${externalIdFromWebhook} atualizado em memória para '${data.status}'.`);

            if (data.status === 'paid') {
                console.log(`🎉 Pagamento ${externalIdFromWebhook} APROVADO pela BuckPay via webhook! Enviando para UTMify.`);
                await sendToUTMify(
                    { amountInCents: transactionInfo.amountInCents },
                    externalIdFromWebhook,
                    transactionInfo.tracking, // Usa o tracking original salvo na criação
                    "paid",
                    transactionInfo.customer,
                    transactionInfo.product,
                    transactionInfo.offer,
                    transactionInfo.gatewayFee || 0 // Usa o gatewayFee atualizado ou 0
                );
            } else if (['refunded', 'canceled', 'expired'].includes(data.status)) {
                console.log(`💔 Pagamento ${externalIdFromWebhook} status final: ${data.status}. Enviando para UTMify.`);
                await sendToUTMify(
                    { amountInCents: transactionInfo.amountInCents },
                    externalIdFromWebhook,
                    transactionInfo.tracking,
                    data.status,
                    transactionInfo.customer,
                    transactionInfo.product,
                    transactionInfo.offer,
                    transactionInfo.gatewayFee || 0
                );
            }
        } else {
            // Se o status não mudou, mas o webhook foi recebido (ex: duplicado), apenas loga.
            console.log(`❕ Webhook para ${externalIdFromWebhook} recebido, mas status '${data.status}' já é o mesmo em memória. Nenhuma ação extra de envio para UTMify.`);
            // Aqui, mesmo que o status não mude, o gatewayFee já foi atualizado acima, se presente.
        }
    }
    // Sempre envia 200 OK para a BuckPay para que ela não retransmita o webhook.
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

        // Se a transação ainda está pendente mas o tempo de vida do Pix na BuckPay (30min) já passou,
        // assume que expirou e marca como tal na memória.
        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > 30) {
            transactionInfo.status = 'expired';
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
            // Poderíamos enviar 'expired' para UTMify aqui também, mas o ideal é que a BuckPay envie o webhook 'expired'.
            // Optamos por não enviar para UTMify aqui para evitar duplicação ou inconsistência se o webhook 'expired' da BuckPay chegar.
        }

        console.log(`Retornando status em memória para ${externalId}: ${transactionInfo.status}`);
        return res.status(200).json({ success: true, status: transactionInfo.status });

    } else {
        console.warn(`Consulta para externalId ${externalId}, mas transação NÃO ENCONTRADA EM MEMÓRIA. Isso pode significar que expirou, foi concluída e limpa, ou nunca existiu.`);
        // Se a transação não está em memória, para o frontend, ela pode ser considerada expirada ou não encontrada.
        return res.status(200).json({ success: true, status: 'not_found_or_expired' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));