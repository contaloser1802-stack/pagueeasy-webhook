import express from "express";
import fetch from "node-fetch";
import cors from 'cors';

const app = express();

app.use(cors({
    origin: ['https://freefirereward.site'], // Apenas o domínio de produção
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

app.post("/webhook/buckpay", async (req, res) => {
    console.log("=== Webhook BuckPay recebido ===");
    console.log("Headers:", req.headers);
    console.log("Body:", JSON.stringify(req.body, null, 2));

    try {
        const { event, data } = req.body;

        if (!event || !data || !data.id || !data.status) {
            console.warn("⚠️ Payload de webhook BuckPay inválido ou incompleto.");
            return res.status(400).json({ error: "Payload de webhook inválido" });
        }

        const transactionId = data.id;
        const status = data.status;
        const eventType = event;

        console.log(`Webhook BuckPay - Transação ID: ${transactionId}, Evento: ${eventType}, Status: ${status}`);

        // --- REMOVA OU AJUSTE ESTE BLOCO DE CÓDIGO ---
        // Se 'data.created_at' não vem no payload, não tente usá-lo.
        // let createdAt;
        // try {
        //     createdAt = new Date(data.created_at);
        //     if (isNaN(createdAt.getTime())) {
        //         throw new Error("Data inválida");
        //     }
        // } catch (error) {
        //     console.error("Erro ao processar created_at:", error);
        //     createdAt = new Date(); // Usa a data atual em caso de erro
        // }
        // const formattedDate = createdAt.toISOString().slice(0, 19).replace('T', ' ');
        // --- FIM DO BLOCO A SER REMOVIDO/AJUSTADO ---

        // O evento de venda paga é 'transaction.processed'
        if (eventType === "transaction.processed" && (status === "approved" || status === "paid")) {
            console.log(`✅ Pagamento ${transactionId} aprovado na BuckPay. Enviando para UTMify.`);

            const customer = data.buyer;
            const totalValueInCents = data.total_amount;
            
            let items = [];
            if (data.product) {
                items.push({ id: data.product.id, name: data.product.name, priceInCents: totalValueInCents, quantity: 1 });
            } else if (data.offer) {
                items.push({ id: data.offer.id, name: data.offer.name, priceInCents: data.offer.discount_price, quantity: data.offer.quantity || 1 });
            } else {
                items.push({ id: "default-item", name: "Recarga Free Fire", priceInCents: totalValueInCents, quantity: 1 });
            }

            // USE A DATA DE APROVAÇÃO COMO REFERÊNCIA PRINCIPAL PARA O UTMify
            const currentFormattedDate = new Date().toISOString().slice(0, 19).replace('T', ' ');

            const utmifyBody = {
                orderId: transactionId.toString(),
                platform: "FreeFireCheckout",
                paymentMethod: "pix",
                status: "paid",
                // Remova 'createdAt' se ele não vem no webhook para este evento, ou defina como a data de aprovação
                createdAt: currentFormattedDate, // Usando a data atual como data de criação/aprovação
                approvedDate: currentFormattedDate, // A data de aprovação é a data que o webhook foi recebido/processado
                customer: {
                    name: customer?.name || "Cliente",
                    email: customer?.email || "cliente@teste.com",
                    phone: customer?.phone || "",
                    document: customer?.document || "",
                    country: "BR",
                    ip: data?.ip_address || ""
                },
                products: items.map(item => ({
                    id: item.id || "recarga-ff",
                    planId: item.planId || "freefire-plan",
                    planName: item.name || "Plano Recarga",
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
                    utm_source: data.tracking?.utm_source || "", // Se 'tracking' vier dentro de 'data'
                    utm_medium: data.tracking?.utm_medium || "",
                    utm_campaign: data.tracking?.utm_campaign || "",
                    utm_content: data.tracking?.utm_content || "",
                    utm_term: data.tracking?.utm_term || ""
                },
                isTest: false
            };
            
            // Certifique-se de que `data.tracking` existe antes de tentar acessar suas propriedades.
            // Pelo seu log anterior, 'tracking' pode não vir no payload da webhook.
            // Você pode precisar buscar os dados de tracking do seu próprio banco de dados
            // associados ao `externalId` se eles não vierem na webhook.
            // Por enquanto, o código acima com `data.tracking?` já trata a ausência.


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