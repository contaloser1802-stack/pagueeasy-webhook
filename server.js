import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// CONFIG UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = "mH3Y79bB6pQKd3aJavkilhVTETVQyDebOhb7"; // <-- Coloque o token real

// Rota que PagueEasy vai chamar
app.post("/webhook/pagueeasy", async (req, res) => {
    console.log("Webhook recebido:", req.body);

    try {
        const { id, status, amount, customer } = req.body;

        // Só processa compra aprovada
        if (status === "APPROVED") {
            const body = {
                orderId: id.toString(),
                platform: "FreeFireCheckout",
                paymentMethod: "pix",
                status: "paid",
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
                        id: "recarga-ff",
                        name: "Recarga Free Fire",
                        quantity: 1,
                        priceInCents: amount
                    }
                ],
                commission: {
                    totalPriceInCents: amount,
                    gatewayFeeInCents: 0,
                    userCommissionInCents: amount
                },
                isTest: false
            };

            // Envia para UTMify
            const response = await fetch(UTMIFY_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-token": UTMIFY_TOKEN
                },
                body: JSON.stringify(body)
            });

            const result = await response.json();
            console.log("UTMify resposta:", result);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Erro no webhook:", error);
        res.sendStatus(500);
    }
});

// Inicia servidor
app.listen(3000, () => console.log("Servidor rodando na porta 3000"));
