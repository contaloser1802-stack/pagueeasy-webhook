import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// --- CONFIGURAÇÕES ---
const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";

// CONFIG UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
// ALTERADO: O TOKEN DA UTMify DEVE SER CARREGADO DE UMA VARIÁVEL DE AMBIENTE POR SEGURANÇA E MANUTENÇÃO!
// Antes era hardcoded: "mH3Y79bB6pQKd3aJavkilhVTETVQyDebOhb7"; agora lê de process.env.
const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN; // <-- AGORA LÊ DA VARIÁVEL DE AMBIENTE


if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render.");
    process.exit(1);
}

// Adicionado aviso para o token da UTMify
if (!UTMIFY_TOKEN) {
    console.warn("Aviso: Variável de ambiente UTMIFY_TOKEN não configurada. A integração com UTMify não funcionará.");
}


// --- ARMAZENAMENTO TEMPORÁRIO EM MEMÓRIA ---
// Chave: externalId
// Valor: {
//    createdAt: Date,
//    buckpayId: string, // ID interno da BuckPay
//    status: string (e.g., 'pending', 'paid', 'expired', 'refunded')
//    tracking: object // <-- NOVO: Armazenar os parâmetros de tracking aqui
//    customer: object, // NOVO: Dados do cliente
//    product: object,  // NOVO: Dados do produto
//    offer: object,    // NOVO: Dados da oferta
//    amountInCents: number // NOVO: Valor em centavos
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
    // Adição de verificação do token UTMify
    if (!UTMIFY_TOKEN) {
        console.warn("[UTMify] Aviso: UTMIFY_TOKEN não configurado. Pulando envio para UTMify.");
        return;
    }

    console.log(`[UTMify] Enviando status '${status}' para orderId: ${externalId}`);

    // GARANTIR QUE orderAmountInCents É UM NÚMERO VÁLIDO E EM CENTAVOS
    const orderAmountInCents = typeof orderData.amountInCents === 'number' && !isNaN(orderData.amountInCents)
                               ? orderData.amountInCents
                               : 0; // Se não for um número válido, assume 0

    // Garante que commission.userCommissionInCents seja pelo menos 1 centavo para 'paid'
    let userCommission = orderAmountInCents - (gatewayFee || 0);
    if (status === 'paid' && orderAmountInCents > 0 && userCommission <= 0) {
        userCommission = 1;
    }

    // A propriedade approvedDate agora será sempre definida, com null se o status não for 'paid'.
    const approvedDateValue = status === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;

    const bodyForUTMify = {
        orderId: externalId,
        platform: "FreeFireCheckout",
        paymentMethod: "pix",
        status: status,
        createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        approvedDate: approvedDateValue, // <<-- AQUI ESTÁ A CORREÇÃO
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
                priceInCents: orderAmountInCents, // <<-- USA O VALOR GARANTIDO
                planId: offerData?.id || "basic",
                planName: offerData?.name || "Plano Básico"
            }
        ],
        commission: {
            totalPriceInCents: orderAmountInCents, // <<-- USA O VALOR GARANTIDO
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
    if (offer_id || offer_name || (discount_price !== null && discount_price !== undefined) || quantity) {
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
                status: 'pending', // Define o status inicial como pendente
                tracking: tracking, // <-- NOVO: Salva os parâmetros de tracking do frontend
                customer: { name, email, document, phone: cleanPhone }, // Salva dados do cliente
                product: product_id && product_name ? { id: product_id, name: product_name } : null,
                offer: offerPayload,
                amountInCents: amountInCents // Salva o valor em centavos
            });
            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);
            // --- FIM DO NOVO BLOCO ---

            // --- NOVO: Enviar para UTMify com status "waiting_payment" ---
            await sendToUTMify(
                { amountInCents: amountInCents }, // Passa o valor
                externalId,
                tracking, // Passa os parâmetros de tracking diretamente
                "waiting_payment", // Status para UTMify
                { name, email, document, phone: cleanPhone }, // Dados do cliente
                product_id && product_name ? { id: product_id, name: product_name } : null,
                offerPayload,
                0 // Gateway fee é 0 para o status de 'waiting_payment' já que não temos o valor ainda
            );
            // --- FIM DO NOVO BLOCO UTMify ---

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
        } else if (data.tracking.utm_id) { // Pode vir como utm_id também
            externalIdFromWebhook = data.tracking.utm_id;
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
            // Atualiza (ou confirma) os dados do cliente e produto/oferta, caso o webhook traga dados mais completos
            transactionInfo.customer = data.buyer || transactionInfo.customer;
            transactionInfo.product = data.product || transactionInfo.product;
            transactionInfo.offer = data.offer || transactionInfo.offer;
            // ATUALIZA amountInCents COM O VALOR DO WEBHook, GARANTINDO QUE É UM NÚMERO VÁLIDO
            transactionInfo.amountInCents = typeof data.amount === 'number' ? data.amount : (transactionInfo.amountInCents || 0);

            console.log(`Status da transação ${externalIdFromWebhook} atualizado em memória para '${data.status}'.`);

            // --- Lógica para UTMify ---
            if (data.status === 'paid') {
                console.log(`🎉 Pagamento ${externalIdFromWebhook} APROVADO pela BuckPay via webhook! Enviando para UTMify.`);

                await sendToUTMify(
                    { amountInCents: transactionInfo.amountInCents }, // <<-- USA O VALOR ATUALIZADO E GARANTIDO DA MEMÓRIA
                    externalIdFromWebhook,
                    transactionInfo.tracking, // Usa os trackingParameters salvos
                    "paid", // Status para UTMify
                    transactionInfo.customer, // Dados do cliente salvos
                    transactionInfo.product,
                    transactionInfo.offer,
                    data.fees?.gateway_fee || 0 // Gateway fee do webhook
                );
            } else if (data.status === 'refunded' || data.status === 'canceled' || data.status === 'expired') {
                console.log(`💔 Pagamento ${externalIdFromWebhook} status final: ${data.status}. Enviando para UTMify.`);
                // Envia para a UTMify com o status correspondente
                await sendToUTMify(
                    { amountInCents: transactionInfo.amountInCents }, // <<-- USA O VALOR ATUALIZADO E GARANTIDO DA MEMÓRIA
                    externalIdFromWebhook,
                    transactionInfo.tracking,
                    data.status, // Usa o status do webhook (refunded, canceled, expired)
                    transactionInfo.customer,
                    transactionInfo.product,
                    transactionInfo.offer,
                    data.fees?.gateway_fee || 0
                );
            }

        } else {
            console.warn(`Webhook para externalId ${externalIdFromWebhook} recebido, mas transação não encontrada em memória. Isso pode acontecer se o servidor reiniciou ou se a transação foi criada há muito tempo e já foi limpa.`);
            // Se a transação não for encontrada em memória, e é um status final como 'paid',
            // você pode considerar enviar a UTMify mesmo assim.
            if (data.status === 'paid') {
                console.warn(`Tentando enviar para UTMify mesmo sem encontrar em memória (APROVADO): ${externalIdFromWebhook}`);

                // GARANTIR QUE data.amount É UM NÚMERO VÁLIDO AO USAR DIRETAMENTE DO WEBHook
                const webhookAmountInCents = typeof data.amount === 'number' ? data.amount : 0;

                await sendToUTMify(
                    { amountInCents: webhookAmountInCents }, // <<-- USA O VALOR GARANTIDO DO WEBHook
                    externalIdFromWebhook,
                    data.tracking, // Usa o tracking do webhook
                    "paid",
                    data.buyer,
                    data.product,
                    data.offer,
                    data.fees?.gateway_fee || 0
                );
            }
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
        // O status "expired" também pode vir via webhook da BuckPay, mas esta lógica
        // garante que o frontend receba essa informação mesmo sem o webhook imediato.
        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > 30) {
            transactionInfo.status = 'expired'; // Marca como expirada para o controle em memória
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
            // Você pode até mesmo enviar um webhook para a UTMify aqui com status 'expired' se quiser.
            // await sendToUTMify(
            //    { amountInCents: transactionInfo.amountInCents },
            //    externalId,
            //    transactionInfo.tracking,
            //    "expired",
            //    transactionInfo.customer,
            //    transactionInfo.product,
            //    transactionInfo.offer,
            //    0
            // );
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