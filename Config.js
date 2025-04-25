// Configurazione dell'applicazione Node.js con Express
const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const Shopify = require('@shopify/shopify-api');
const paypal = require('@paypal/checkout-server-sdk');

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

// Inizializzazione PayPal
function getPayPalClient() {
  const environment = process.env.NODE_ENV === 'production'
    ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
  
  return new paypal.core.PayPalHttpClient(environment);
}

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

// Funzione per creare un ordine PayPal
async function createPayPalOrder(amount, currency = 'EUR', orderDescription) {
  try {
    const paypalClient = getPayPalClient();
    const request = new paypal.orders.OrdersCreateRequest();
    
    // Conversione in formato corretto per PayPal (due decimali come stringa)
    const formattedAmount = amount.toFixed(2);
    
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: formattedAmount,
          breakdown: {
            item_total: {
              currency_code: currency,
              value: (amount - SERVICE_FEE).toFixed(2)
            },
            handling: {
              currency_code: currency,
              value: SERVICE_FEE.toFixed(2)
            }
          }
        },
        description: orderDescription,
        custom_id: Date.now().toString(),
        items: [
          {
            name: 'Commissione servizio',
            unit_amount: {
              currency_code: currency,
              value: SERVICE_FEE.toFixed(2)
            },
            quantity: '1',
            description: 'Commissione per il servizio di orchestrazione'
          }
        ]
      }],
      application_context: {
        brand_name: 'Magico Emporio di Shopify',
        landing_page: 'BILLING',
        shipping_preference: 'SET_PROVIDED_ADDRESS',
        user_action: 'PAY_NOW',
        return_url: `${process.env.APP_URL}/paypal-success`,
        cancel_url: `${process.env.APP_URL}/paypal-cancel`
      }
    });

    const response = await paypalClient.execute(request);
    
    return {
      orderId: response.result.id,
      approvalUrl: response.result.links.find(link => link.rel === 'approve').href,
      status: response.result.status
    };
  } catch (error) {
    console.error("Errore PayPal:", error);
    throw new Error("Impossibile creare l'ordine PayPal");
  }
}

// Funzione per catturare un pagamento PayPal già approvato
async function capturePayPalOrder(orderId) {
  try {
    const paypalClient = getPayPalClient();
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});
    
    const response = await paypalClient.execute(request);
    
    return {
      captureId: response.result.purchase_units[0].payments.captures[0].id,
      status: response.result.status,
      result: response.result
    };
  } catch (error) {
    console.error("Errore nella cattura del pagamento PayPal:", error);
    throw new Error("Impossibile completare il pagamento");
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
        
        // Creazione dell'ordine Shopify
        const orderResult = await createShopifyOrder(
          session, 
          req.body.productId, 
          intent.quantity || 1, 
          customerInfo
        );
        
        // Creazione dell'ordine PayPal
        const paypalOrder = await createPayPalOrder(
          orderResult.total,
          'EUR',
          `Ordine #${orderResult.order.order_number} con commissione servizio`
        );
        
        response = {
          message: `Ho creato un ordine per te. Il totale è ${orderResult.total}€ (inclusa commissione di ${SERVICE_FEE}€).`,
          order: orderResult.order,
          payment: {
            provider: 'paypal',
            orderId: paypalOrder.orderId,
            approvalUrl: paypalOrder.approvalUrl,
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

// Endpoint per catturare un pagamento PayPal dopo l'approvazione dell'utente
app.post('/api/capture-payment', async (req, res) => {
  try {
    const { paypalOrderId } = req.body;
    
    if (!paypalOrderId) {
      return res.status(400).json({ error: "ID ordine PayPal mancante" });
    }
    
    const captureResult = await capturePayPalOrder(paypalOrderId);
    
    res.json({
      success: true,
      captureId: captureResult.captureId,
      status: captureResult.status
    });
  } catch (error) {
    console.error("Errore nella cattura del pagamento:", error);
    res.status(500).json({ error: "Impossibile completare il pagamento" });
  }
});

// Endpoint per le webhook di Shopify
app.post('/api/shopify/webhooks', async (req, res) => {
  // Implementazione delle webhook per gestire eventi Shopify
  res.status(200).send();
});

// Endpoint per le webhook di PayPal
app.post('/api/paypal/webhooks', async (req, res) => {
  // Implementazione delle webhook per gestire eventi PayPal
  try {
    const event = req.body;
    
    // Verifica dell'evento PayPal (in produzione si dovrebbe verificare la firma)
    
    // Esempio di gestione eventi
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      // Aggiornare lo stato dell'ordine nel tuo database
      console.log('Pagamento completato:', event.resource.id);
    }
    
    res.status(200).send();
  } catch (error) {
    console.error('Errore webhook PayPal:', error);
    res.status(500).send();
  }
});

// Avvio del server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

// File .env da creare (esempio)

OPENAI_API_KEY=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
SHOPIFY_API_KEY=30d77a9fcf9a7c3d0e66ab68fbc08aeb
SHOPIFY_API_SECRET=2da34766bf6258b50812fa894fd01cea
SHOPIFY_HOST_NAME=https://keyboardinhobbiton.github.io/bich/
PAYPAL_CLIENT_ID=your_paypal_client_id
PAYPAL_CLIENT_SECRET=your_paypal_client_secret
APP_URL=https://keyboardinhobbiton.github.io/bich
NODE_ENV=development
PORT=3000
