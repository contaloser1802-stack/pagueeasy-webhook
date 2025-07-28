import express from "express";
import fetch from "node-fetch";
import cors from 'cors';

const app = express();

app.use(cors({
    origin: ['http://localhost:8080', 'http://127.0.0.1:8080'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = "mH3Y79bB6pQKd3aJavkilhVTETVQyDebOhb7";

const BUCK_PAY_URL = "https://api.realtechdev.com.br/v1/transactions";
const BUCK_PAY_API_KEY = "sk_live_69b0ed89aaa545ef5e67bfcef2c3e0c4";

app.get("/", (req, res) => {
    res.send("Servidor online e rodando!");
});

app.post("/create-payment", async (req, res) => {
    try {
        const { email, telefone, nome, total, items, tracking, cpf } = req.body;

        console.log("Valor de 'nome' recebido do frontend:", nome);

        const externalId = `order_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

        const telefoneNumerico = telefone ? telefone.replace(/\D/g, '') : '';
        const telefoneFormatado = telefoneNumerico.startsWith('55') ? telefoneNumerico : `55${telefoneNumerico}`;

        const cpfNumerico = cpf ? cpf.replace(/\D/g, '') : '';


        const payload = {
            amount: Math.round(total * 100),
            currency: "BRL",
            payment_method: "pix",
            external_id: externalId, // This is your generated external_id
            buyer: {
                name: nome,
                email: email,
                phone: telefoneFormatado,
                document: cpfNumerico,
            },
            metadata: {
                order_items: items,
                utm_source: tracking?.utm?.source || "",
                utm_medium: tracking?.utm?.medium || "",
                utm_campaign: tracking?.utm?.campaign || "",
                utm_content: tracking?.utm?.content || "",
                utm_term: tracking?.utm?.term || "",
                xcod: tracking?.xcod || "",
                sck: tracking?.sck || "",
                cid: "" // Este 'cid' parece ser o que vem do UTMify no frontend
            }
        };

        console.log("Payload enviado para BuckPay:", JSON.stringify(payload, null, 2));

        const response = await fetch(BUCK_PAY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BUCK_PAY_API_KEY}`
            },
            body: JSON.stringify(payload)
        });

if (!response.ok) {
    const errorDetails = await response.text();
    console.error(`Erro ao consultar status da BuckPay (HTTP status ${response.status}):`, errorDetails);
    return res.status(500).json({
        success: false,
        error: "Erro ao consultar status na BuckPay.",
        details: errorDetails,
        http_status: response.status
    });
}
const data = await response.json();
console.log("Resposta da BuckPay:", JSON.stringify(data, null, 2));

// Verifique se a resposta contém os campos necessários
if (data.data && data.data.pix && data.data.pix.qrcode_base64) {
    res.status(200).json({
        pix: { 
            code: data.data.pix.code,
            qrcode_base64: data.data.pix.qrcode_base64
        },
        transactionId: data.data.id
    });
} else {
    console.error("Erro na resposta da BuckPay (dados Pix incompletos):", data);
    res.status(400).json({
        message: "Dados Pix incompletos na resposta da BuckPay.",
        details: data
    });
}

    } catch (error) {
        console.error("Erro ao criar transação com BuckPay:", error);
        res.status(500).json({ error: "Erro interno ao criar transação" });
    }
});

// Função para criar um delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get("/payment-status", async (req, res) => {
    try {
        const queriedExternalId = req.query.id;
        if (!queriedExternalId) {
            return res.status(400).json({ error: "ID externo da transação é obrigatório." });
        }

        const BUCK_PAY_STATUS_URL = `${BUCK_PAY_URL}/external_id/${queriedExternalId}`;
        console.log(`Consultando status da transação com external_id: ${queriedExternalId}`);

        let attempts = 0;
        let statusData = null;

        // Tentando até 5 vezes com intervalo de 5 segundos
        while (attempts < 5) {
            const response = await fetch(BUCK_PAY_STATUS_URL, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${BUCK_PAY_API_KEY}`
                }
            });

            if (response.ok) {
                statusData = await response.json();
                console.log("Status da transação:", statusData);
                break;
            }

            attempts++;
            console.log(`Tentativa ${attempts} falhou. Tentando novamente em 10 segundos...`);
            await delay(10000); // Espera 5 segundos antes de tentar novamente
        }

        if (!statusData) {
            return res.status(500).json({ error: "Não foi possível consultar o status após várias tentativas." });
        }

        const status = statusData.data?.status;
        let statusFrontend = "pending";
        if (status === "approved" || status === "paid") {
            statusFrontend = "approved";
        } else if (status === "canceled" || status === "refunded" || status === "expired") {
            statusFrontend = status;
        }

        res.status(200).json({ status: statusFrontend, buckPayData: statusData });

    } catch (error) {
        console.error("Erro ao consultar status da BuckPay:", error);
        res.status(500).json({ error: "Erro interno ao consultar status" });
    }
});
app.post("/webhook/buckpay", async (req, res) => {
    console.log("=== Webhook BuckPay recebido ===");
    console.log("Headers:", req.headers);
    console.log("Body:", JSON.stringify(req.body, null, 2));

    try {
        // A estrutura do webhook da BuckPay é 'event' e 'data' no corpo da requisição
        const { event, data } = req.body;

        // Verifica se o payload essencial está presente
        if (!event || !data || !data.id || !data.status) {
             console.warn("⚠️ Payload de webhook BuckPay inválido ou incompleto.");
             return res.status(400).json({ error: "Payload de webhook inválido" });
        }

        const transactionId = data.id; // ID interno da BuckPay do webhook
        const status = data.status;
        const eventType = event;

        console.log(`Webhook BuckPay - Transação ID: ${transactionId}, Evento: ${eventType}, Status: ${status}`);

        // O evento de venda paga é 'transaction.processed'
        if (eventType === "transaction.processed" && (status === "approved" || status === "paid")) {
            console.log(`✅ Pagamento ${transactionId} aprovado na BuckPay. Enviando para UTMify.`);

            const customer = data.buyer; // Webhook usa 'buyer' diretamente em 'data'
            const totalValueInCents = data.total_amount; // Usar total_amount do webhook
            
            // Lidar com produtos/ofertas do webhook. Adaptar conforme a estrutura real do seu produto/oferta no webhook.
            let items = [];
            if (data.product) {
                items.push({ id: data.product.id, name: data.product.name, priceInCents: totalValueInCents, quantity: 1 });
            } else if (data.offer) {
                items.push({ id: data.offer.id, name: data.offer.name, priceInCents: data.offer.discount_price, quantity: data.offer.quantity || 1 });
            } else {
                // Se não houver product nem offer, tentar usar os items do metadata se existirem
                items = data.metadata?.order_items || [];
            }


            const utmifyBody = {
                orderId: transactionId.toString(),
                platform: "FreeFireCheckout",
                paymentMethod: "pix",
                status: "paid",
                createdAt: new Date(data.created_at).toISOString().slice(0, 19).replace('T', ' '),
                approvedDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
                customer: {
                    name: customer?.name || "Cliente",
                    email: customer?.email || "cliente@teste.com",
                    phone: customer?.phone || "",
                    document: customer?.document || "",
                    country: "BR",
                    ip: data?.ip_address || "" // IP address pode vir no objeto principal 'data' do webhook
                },
                products: items.map(item => ({
                    id: item.id || "recarga-ff",
                    planId: item.planId || "freefire-plan", // Placeholder se não estiver no webhook
                    planName: item.name || "Plano Recarga", // Usando item.name para planName
                    name: item.name || "Recarga Free Fire",
                    quantity: item.quantity || 1,
                    priceInCents: item.priceInCents || 0
                })),
                commission: {
                    totalPriceInCents: totalValueInCents || 0,
                    gatewayFeeInCents: 0,
                    userCommissionInCents: totalValueInCents || 0
                },
                trackingParameters: {
                    utm_source: data.tracking?.utm_source || "", // Acesso direto do 'data.tracking' do webhook
                    utm_medium: data.tracking?.utm_medium || "",
                    utm_campaign: data.tracking?.utm_campaign || "",
                    utm_content: data.tracking?.utm_content || "",
                    utm_term: data.tracking?.utm_term || ""
                },
                isTest: false
            };

            const responseUtmify = await fetch(UTMIFY_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-token": UTMIFY_TOKEN
                },
                body: JSON.stringify(utmifyBody)
            });

            const resultUtmify = await responseUtmify.json();
            console.log("UTMify resposta do webhook:", resultUtmify);

            if (!responseUtmify.ok) {
                console.error("Erro ao enviar dados para UTMify via webhook:", resultUtmify);
            }
        } else if (eventType === "transaction.created" && status === "pending") {
            console.log(`ℹ️ Pagamento ${transactionId} criado e pendente na BuckPay.`);
        } else {
            console.log(`ℹ️ Pagamento ${transactionId} com status: ${status} (Evento: ${eventType}). Nenhuma ação específica para UTMify.`);
        }

        res.status(200).json({ message: "Webhook processado com sucesso" });
    } catch (error) {
        console.error("Erro no webhook BuckPay:", error);
        res.status(500).json({ error: "Erro interno ao processar webhook" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));