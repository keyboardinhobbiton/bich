// Configurazione dell'applicazione Node.js con Express
const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const Shopify = require('@shopify/shopify-api');
const stripe = require('stripe');

// Caricamento variabili d'ambiente
dotenv.config();

// Inizializzazione Express
const app = express();
app.use(bodyParser.json());

// Inizializzazione OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Inizializzazione Shopify
const shopify = Shopify.shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products', 'write_orders'],
  hostName: process.env.SHOPIFY_HOST_NAME,
  apiVersion: '2023-07'
});

// Inizializzazione Stripe per gestire i pagamenti
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// Commissione per il servizio
const SERVICE_FEE = 0.50; // in euro

// Funzione per generare risposte con OpenAI
async function generateAIResponse(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "Sei un assistente che aiuta a gestire ordini e transazioni e-commerce." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 500
    });
    
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Errore OpenAI:", error);
    throw new Error("Impossibile generare una risposta AI");
  }
}

// Funzione per interpretare l'intento dell'utente
async function interpretUserIntent(userMessage) {
  try {
    const prompt = `
      Analizza il seguente messaggio dell'utente e classifica l'intento come una delle seguenti operazioni:
      - SEARCH_PRODUCT: cerca un prodotto
      - CREATE_ORDER: crea un ordine
      - CHECK_INVENTORY: controlla disponibilità
      - OTHER: altro

      Se l'intento è SEARCH_PRODUCT, estrai il nome del prodotto.
      Se l'intento è CREATE_ORDER, estrai prodotto e quantità.

      Messaggio utente: "${userMessage}"
      
      Rispondi in formato JSON con i campi: intent, productName (se applicabile), quantity (se applicabile)
    `;
    
    const response = await generateAIResponse(prompt);
    return JSON.parse(response);
  } catch (error) {
    console.error("Errore nell'interpretazione:", error);
    return { intent: "OTHER" };
  }
}

// Funzione per cercare prodotti su Shopify
async function searchShopifyProduct(session, productName) {
  try {
    const client = new shopify.clients.Rest({ session });
    const response = await client.get({
      path: 'products',
      query: { title: productName }
    });
    
    return response.body.products;
  } catch (error) {
    console.error("Errore Shopify:", error);
    throw new Error("Impossibile cercare prodotti");
  }
}

// Funzione per creare un ordine su Shopify
async function createShopifyOrder(session, productId, quantity, customerInfo) {
  try {
    const client = new shopify.clients.Rest({ session });
    
    // Prima otteniamo i dettagli del prodotto per il prezzo
    const productResponse = await client.get({
      path: `products/${productId}`,
    });
    
    const product = productResponse.body.product;
    const variantId = product.variants[0].id;
    const price = parseFloat(product.variants[0].price);
    
    // Calcolo del totale con commissione
    const subtotal = price * quantity;
    const total = subtotal + SERVICE_FEE;
    
    // Creazione dell'ordine
    const orderResponse = await client.post({
      path: 'orders',
      data: {
        order: {
          line_items: [
            {
              variant_id: variantId,
              quantity: quantity,
              price: price.toString()
            }
          ],
          customer: customerInfo,
          total_price: total.toString(),
          financial_status: "pending"
        }
      }
    });
    
    return {
      order: orderResponse.body.order,
      subtotal,
      serviceFee: SERVICE_FEE,
      total
    };
  } catch (error) {
    console.error("Errore creazione ordine:", error);
    throw new Error("Impossibile creare l'ordine");
  }
}

// Creazione del pagamento con Stripe
async function createPaymentIntent(amount, currency = 'eur', customer) {
  try {
    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: Math.round(amount * 100), // Conversione in centesimi
      currency,
      customer: customer.id,
      description: `Ordine con commissione servizio di ${SERVICE_FEE} EUR`,
      metadata: {
        serviceFee: SERVICE_FEE
      }
    });
    
    return paymentIntent;
  } catch (error) {
    console.error("Errore Stripe:", error);
    throw new Error("Impossibile processare il pagamento");
  }
}

// Endpoint per la chat con l'assistente AI
app.post('/api/chat', async (req, res) => {
  try {
    const { message, userId, shopifyStoreUrl } = req.body;
    
    if (!message || !userId || !shopifyStoreUrl) {
      return res.status(400).json({ error: "Parametri mancanti" });
    }
    
    // Otteniamo una sessione Shopify
    const session = await shopify.session.customAppSession(shopifyStoreUrl);
    
    // Interpretiamo l'intento dell'utente
    const intent = await interpretUserIntent(message);
    
    let response;
    
    // Gestiamo l'intento dell'utente
    switch (intent.intent) {
      case "SEARCH_PRODUCT":
        const products = await searchShopifyProduct(session, intent.productName);
        if (products.length > 0) {
          response = {
            message: `Ho trovato ${products.length} prodotti per "${intent.productName}":`,
            products: products.map(p => ({
              id: p.id,
              title: p.title,
              price: p.variants[0].price,
              available: p.variants[0].inventory_quantity > 0
            }))
          };
        } else {
          response = { message: `Non ho trovato prodotti per "${intent.productName}".` };
        }
        break;
        
      case "CREATE_ORDER":
        // In un caso reale, recupereremmo il productId dal front-end dopo la ricerca
        // Qui per semplicità assumiamo che arriva dalla richiesta
        if (!req.body.productId) {
          response = { message: "Per favore, seleziona prima un prodotto specifico." };
          break;
        }
        
        // Esempio di info cliente - in produzione verrebbe dal profilo utente
        const customerInfo = {
          first_name: req.body.firstName || "Cliente",
          last_name: req.body.lastName || "Test",
          email: req.body.email || "cliente@example.com"
        };
        
        // Creazione dell'ordine
        const orderResult = await createShopifyOrder(
          session, 
          req.body.productId, 
          intent.quantity || 1, 
          customerInfo
        );
        
        // Creazione dell'intento di pagamento
        const customerId = req.body.stripeCustomerId; // Assumiamo che sia già registrato
        const paymentIntent = await createPaymentIntent(
          orderResult.total, 
          'eur', 
          { id: customerId }
        );
        
        response = {
          message: `Ho creato un ordine per te. Il totale è ${orderResult.total}€ (inclusa commissione di ${SERVICE_FEE}€).`,
          order: orderResult.order,
          payment: {
            clientSecret: paymentIntent.client_secret,
            amount: orderResult.total,
            serviceFee: SERVICE_FEE
          }
        };
        break;
        
      case "CHECK_INVENTORY":
        // Implementazione check inventario
        response = { message: "Funzionalità di controllo inventario in fase di sviluppo." };
        break;
        
      default:
        // Per qualsiasi altro intento, generiamo una risposta generica con l'AI
        const aiResponse = await generateAIResponse(
          `L'utente ha detto: "${message}". Rispondi come un assistente e-commerce amichevole.`
        );
        response = { message: aiResponse };
    }
    
    res.json(response);
  } catch (error) {
    console.error("Errore generale:", error);
    res.status(500).json({ error: "Si è verificato un errore durante l'elaborazione della richiesta." });
  }
});

// Endpoint per le webhook di Shopify
app.post('/api/shopify/webhooks', async (req, res) => {
  // Implementazione delle webhook per gestire eventi Shopify
  res.status(200).send();
});

// Endpoint per i webhook di Stripe
app.post('/api/stripe/webhooks', async (req, res) => {
  // Implementazione delle webhook per gestire eventi Stripe
  res.status(200).send();
});

// Avvio del server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

// File .env da creare (esempio)
/*
OPENAI_API_KEY=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
SHOPIFY_API_KEY=your_shopify_api_key
SHOPIFY_API_SECRET=your_shopify_api_secret
SHOPIFY_HOST_NAME=your_app_url
STRIPE_SECRET_KEY=your_stripe_secret_key
PORT=3000
*/
