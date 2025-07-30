import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // Certifique-se de que 'node-fetch' está instalado: npm install node-fetch

const app = express();

// --- CONFIGURAÇÕES DE VARIÁVEIS DE AMBIENTE ---
// É CRÍTICO que estas variáveis sejam configuradas no ambiente onde o servidor roda (ex: Render, Heroku).
const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";

// CONFIG UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
// O TOKEN DA UTMify DEVE SER CARREGADO DE UMA VARIÁVEL DE AMBIENTE POR SEGURANÇA!
// Por exemplo, no Render, adicione UTMIFY_TOKEN nas variáveis de ambiente.
const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN;

// Verifica se as chaves API necessárias estão configuradas
if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada. Por favor, configure-a no seu ambiente (ex: Render).");
    process.exit(1); // Encerra a aplicação se a chave essencial não estiver presente
}
if (!UTMIFY_TOKEN) {
    console.error("Erro: Variável de ambiente UTMIFY_TOKEN não configurada. Por favor, configure-a para a integração com UTMify.");
    // Não encerra a aplicação, mas o envio para UTMify não funcionará
}

// --- ARMAZENAMENTO TEMPORÁRIO EM MEMÓRIA ---
// Este Map armazena informações sobre as transações pendentes.
// Chave: externalId (ID gerado pelo seu sistema)
// Valor: Objeto contendo detalhes da transação.
const pendingTransactions = new Map();

// Tempo de vida máximo para uma transação em memória antes de ser limpa.
// Pix expira em 30min na BuckPay. Guardamos por um pouco mais para garantir que o webhook chegue
// e a informação seja útil para o frontend durante a janela de pagamento.
const TRANSACTION_LIFETIME_MINUTES = 35;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Rodar limpeza a cada 5 minutos

/**
 * Limpa transações expiradas ou finalizadas da memória.
 * Transações que não estão mais "pending" ou que excederam o tempo de vida são removidas.
 */
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

// --- FUNÇÃO PARA ENVIAR PARA UTMify ---
/**
 * Envia dados de transação para a API da UTMify.
 * @param {object} orderData - Dados gerais do pedido, incluindo amountInCents.
 * @param {string} externalId - ID externo da transação.
 * @param {object} trackingParameters - Parâmetros de rastreamento (utm_source, utm_medium, etc.).
 * @param {string} status - Status da transação (ex: 'waiting_payment', 'paid', 'refunded', 'canceled', 'expired').
 * @param {object} customerData - Dados do cliente.
 * @param {object} productData - Dados do produto.
 * @param {object} offerData - Dados da oferta.
 * @param {number} gatewayFee - Taxa do gateway de pagamento em centavos.
 */
async function sendToUTMify(orderData, externalId, trackingParameters, status, customerData, productData, offerData, gatewayFee) {
    if (!UTMIFY_TOKEN) {
        console.warn("[UTMify] Aviso: UTMIFY_TOKEN não configurado. Pulando envio para UTMify.");
        return;
    }

    console.log(`[UTMify] Enviando status '${status}' para orderId: ${externalId}`);

    // Garante que commission.userCommissionInCents seja pelo menos 1 centavo para 'paid'
    // A comissão do usuário é o valor total menos a taxa do gateway.
    let userCommission = (orderData.amountInCents || 0) - (gatewayFee || 0);
    // Se a comissão for 0 ou negativa para um pagamento aprovado, define como 1 centavo.
    if (status === 'paid' && userCommission <= 0 && (orderData.amountInCents || 0) > 0) {
        userCommission = 1;
    }

    const bodyForUTMify = {
        orderId: externalId,
        platform: "FreeFireCheckout", // Nome da sua plataforma
        paymentMethod: "pix",
        status: status,
        createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        // approvedDate só é preenchido se o status for 'paid'
        approvedDate: status === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : undefined,
        customer: {
            name: customerData?.name || "Cliente Desconhecido", // Nome padrão se não fornecido
            email: customerData?.email || "desconhecido@example.com", // Email padrão
            phone: customerData?.phone || "",
            document: customerData?.document || "",
            country: "BR"
        },
        products: [
            {
                id: productData?.id || "default-product",
                name: productData?.name || "Produto Padrão",
                quantity: offerData?.quantity || 1,
                priceInCents: orderData.amountInCents || 0,
                planId: offerData?.id || "no-offer-id",
                planName: offerData?.name || "Sem Oferta Específica"
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
        isTest: false // Defina como 'true' para testes na UTMify
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
            console.log("[UTMify] Resposta de sucesso:", resultUTMify);
        }
    } catch (utmifyError) {
        console.error("[UTMify Error] Erro ao enviar dados para UTMify:", utmifyError);
    }
}
// --- FIM DA FUNÇÃO UTMify ---


// --- MIDDLEWARES ---
app.use(cors({
    origin: 'https://freefirereward.site', // IMPORTANTE: Mantenha este domínio correto para seu frontend
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

// Rota para obter o IP do servidor (útil para configurar webhooks, se necessário)
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

/**
 * Rota para criar transação PIX via BuckPay.
 * Recebe dados do frontend, formata o payload para a BuckPay, cria a transação,
 * armazena em memória e envia o status inicial para UTMify.
 */
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
    // Adiciona o código do país (55) se não presente e tenta inferir DDD (ex: 11)
    if (cleanPhone.length > 0 && !cleanPhone.startsWith('55')) {
        if (cleanPhone.length === 9) { // Ex: 912345678 (sem DDD) -> assume DDD 11
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 10 || cleanPhone.length === 11) { // Ex: 11912345678 (com DDD)
            cleanPhone = `55${cleanPhone}`;
        }
    }
    // Caso o telefone ainda seja inválido ou vazio, usa um placeholder
    if (cleanPhone.length < 12) { // Formato mínimo esperado 55DDNNNNNNNN
        cleanPhone = "5511987654321"; // Telefone genérico para evitar erro na API da BuckPay
    }
    cleanPhone = cleanPhone.substring(0, 13); // Garante o tamanho máximo para a API (ex: 5511987654321)

    // Montagem do payload da oferta, se houver
    let offerPayload = null;
    if (offer_id || offer_name || (discount_price !== null && discount_price !== undefined)) {
        offerPayload = {
            id: offer_id || "default_offer_id",
            name: offer_name || "Oferta Padrão",
            // Converte discount_price para centavos, se existir
            discount_price: (discount_price !== null && discount_price !== undefined) ? Math.round(parseFloat(discount_price) * 100) : 0,
            quantity: quantity || 1
        };
    }

    // Montagem dos parâmetros de rastreamento para a BuckPay
    // O 'ref' é crucial para identificar a transação no webhook da BuckPay.
    let buckpayTracking = {
        utm_source: tracking?.utm_source || 'direct',
        utm_medium: tracking?.utm_medium || 'website',
        utm_campaign: tracking?.utm_campaign || 'no_campaign',
        src: tracking?.utm_source || 'direct',
        utm_id: tracking?.xcod || tracking?.cid || externalId,
        ref: tracking?.cid || externalId, // ESSENCIAL: BuckPay retorna 'ref' no webhook
        sck: tracking?.sck || 'no_sck_value',
        utm_term: tracking?.utm_term || '',
        utm_content: tracking?.utm_content || '',
    };

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
        // Envia product e offer como null se não houver dados válidos
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
                "User-Agent": "Buckpay API Integration" // Boa prática para identificar sua aplicação
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
            // Armazena a transação em memória após criar o Pix
            pendingTransactions.set(externalId, {
                createdAt: new Date(), // Registra o momento da criação
                buckpayId: data.data.id, // Armazena o ID interno da BuckPay para referência
                status: 'pending', // Define o status inicial como pendente
                tracking: tracking, // Salva os parâmetros de tracking originais do frontend
                customer: { name, email, document, phone: cleanPhone }, // Salva dados do cliente
                product: product_id && product_name ? { id: product_id, name: product_name } : null,
                offer: offerPayload,
                amountInCents: amountInCents // Salva o valor em centavos
            });
            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);

            // Enviar para UTMify com status "waiting_payment"
            await sendToUTMify(
                { amountInCents: amountInCents }, // Passa o valor original da criação
                externalId,
                tracking, // Passa os parâmetros de tracking diretamente
                "waiting_payment", // Status para UTMify
                { name, email, document, phone: cleanPhone }, // Dados do cliente
                product_id && product_name ? { id: product_id, name: product_name } : null,
                offerPayload,
                0 // Gateway fee é 0 para o status de 'waiting_payment' já que não temos o valor ainda
            );

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

/**
 * Rota de Webhook da BuckPay.
 * Recebe notificações de status da BuckPay, atualiza o status da transação em memória
 * e envia o status final para a UTMify.
 */
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

    // Atualiza o status em memória e processa
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
            transactionInfo.amountInCents = data.amount || transactionInfo.amountInCents;

            console.log(`Status da transação ${externalIdFromWebhook} atualizado em memória para '${data.status}'.`);

            // Lógica para UTMify
            if (data.status === 'paid') {
                console.log(`🎉 Pagamento ${externalIdFromWebhook} APROVADO pela BuckPay via webhook! Enviando para UTMify.`);
                await sendToUTMify(
                    { amountInCents: data.amount }, // Usa o valor do webhook da BuckPay (é o valor final)
                    externalIdFromWebhook,
                    transactionInfo.tracking, // Usa os trackingParameters salvos na criação
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
                    { amountInCents: data.amount }, // Usa o valor do webhook da BuckPay
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
            console.warn(`Webhook para externalId ${externalIdFromWebhook} recebido, mas transação não encontrada em memória.`);
            // Se a transação não for encontrada em memória (ex: servidor reiniciou),
            // mas o status é 'paid', você pode tentar enviar para UTMify com os dados disponíveis do webhook.
            if (data.status === 'paid') {
                console.warn(`Tentando enviar para UTMify (status PAID) mesmo sem encontrar em memória: ${externalIdFromWebhook}`);
                await sendToUTMify(
                    { amountInCents: data.amount },
                    externalIdFromWebhook,
                    data.tracking, // Usa o tracking diretamente do webhook
                    "paid",
                    data.buyer,
                    data.product,
                    data.offer,
                    data.fees?.gateway_fee || 0
                );
            }
        }
    }
    // Sempre responda 200 OK para o webhook indicar que você o recebeu com sucesso
    res.status(200).send("Webhook recebido com sucesso!");
});

/**
 * Rota de Consulta de Status para o Frontend.
 * Permite que o frontend consulte o status de uma transação pelo externalId.
 * A leitura é feita APENAS do Map em memória.
 */
app.get("/check-order-status", async (req, res) => {
    const externalId = req.query.id;

    if (!externalId) {
        return res.status(400).json({ error: "ID externo da transação não fornecido." });
    }

    const transactionInfo = pendingTransactions.get(externalId);
    const now = new Date();

    if (transactionInfo) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        // Se a transação estiver pendente e o tempo de vida do Pix (30min BuckPay) já passou,
        // marcamos como 'expired' em memória e informamos ao frontend.
        // Isso cobre casos onde o webhook de expiração da BuckPay pode atrasar ou falhar.
        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > 30) {
            transactionInfo.status = 'expired'; // Marca como expirada para o controle em memória
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
            // Opcional: Você pode até mesmo enviar um webhook para a UTMify aqui com status 'expired' se quiser garantir.
            // await sendToUTMify(
            //     { amountInCents: transactionInfo.amountInCents },
            //     externalId,
            //     transactionInfo.tracking,
            //     "expired",
            //     transactionInfo.customer,
            //     transactionInfo.product,
            //     transactionInfo.offer,
            //     0
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
        // Em ambos os casos, não temos mais o status para informar o frontend de forma precisa.
        console.warn(`Consulta para externalId ${externalId}, mas transação NÃO ENCONTRADA EM MEMÓRIA. Retornando 'not_found_or_expired'.`);
        // Informa um status genérico para que o frontend possa lidar (ex: sugerir novo Pix)
        return res.status(200).json({ success: true, status: 'not_found_or_expired' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000; // Usa a porta definida pelo ambiente (Render) ou 3000 como fallback
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));