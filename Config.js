// app.js - Applicazione principale

const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');

// Carica variabili d'ambiente
dotenv.config();

// Inizializza l'app Express
const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Inizializza OpenAI con la tua API key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// URL base per Fake Store API
const FAKE_STORE_API_URL = 'https://fakestoreapi.com';

// Commissione di servizio (in euro)
const SERVICE_FEE = 0.50;

// Endpoint per ottenere tutti i prodotti
app.get('/api/products', async (req, res) => {
  try {
    const response = await axios.get(`${FAKE_STORE_API_URL}/products`);
    res.json(response.data);
  } catch (error) {
    console.error('Errore nel recupero dei prodotti:', error);
    res.status(500).json({ error: 'Errore nel recupero dei prodotti' });
  }
});

// Endpoint per ottenere un singolo prodotto
app.get('/api/products/:id', async (req, res) => {
  try {
    const response = await axios.get(`${FAKE_STORE_API_URL}/products/${req.params.id}`);
    res.json(response.data);
  } catch (error) {
    console.error('Errore nel recupero del prodotto:', error);
    res.status(500).json({ error: 'Errore nel recupero del prodotto' });
  }
});

// Endpoint per processare richieste in linguaggio naturale
app.post('/api/assistant', async (req, res) => {
  try {
    const { message } = req.body;

    // Prima ottieni la lista dei prodotti disponibili
    const productsResponse = await axios.get(`${FAKE_STORE_API_URL}/products`);
    const products = productsResponse.data;
    
    // Prepara i prodotti in un formato più semplice per OpenAI
    const productsList = products.map(p => (
      `ID: ${p.id}, Nome: ${p.title}, Categoria: ${p.category}, Prezzo: €${p.price}`
    )).join('\n');

    // Chiedi a OpenAI di interpretare la richiesta dell'utente
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Tu sei un assistente per lo shopping che aiuta gli utenti a trovare e acquistare prodotti. 
          Ecco la lista dei prodotti disponibili:
          ${productsList}
          
          Se l'utente vuole acquistare un prodotto, identifica il prodotto e restituisci un oggetto JSON con:
          1. action: "purchase"
          2. productId: l'ID del prodotto
          3. quantity: la quantità da acquistare
          
          Se l'utente vuole informazioni su un prodotto, restituisci:
          1. action: "info"
          2. productId: l'ID del prodotto
          
          Se l'utente vuole cercare prodotti, restituisci:
          1. action: "search"
          2. category: la categoria (se specificata)
          3. query: i termini di ricerca
          
          Rispondi SOLO con JSON valido.`
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    // Estrai la risposta di OpenAI
    const assistantResponse = completion.choices[0].message.content;
    
    // Prova a parsare la risposta come JSON
    try {
      const action = JSON.parse(assistantResponse);
      
      // In base all'azione, esegui la relativa operazione
      let result;
      
      switch(action.action) {
        case 'purchase':
          // Ottieni i dettagli del prodotto
          const productResponse = await axios.get(`${FAKE_STORE_API_URL}/products/${action.productId}`);
          const product = productResponse.data;
          
          // Calcola il costo totale con la commissione
          const subtotal = product.price * action.quantity;
          const total = subtotal + SERVICE_FEE;
          
          // Simula una transazione di acquisto
          const purchaseResult = await axios.post(`${FAKE_STORE_API_URL}/carts`, {
            userId: 1,  // Simula un utente
            date: new Date(),
            products: [{ productId: action.productId, quantity: action.quantity }]
          });
          
          result = {
            success: true,
            product,
            quantity: action.quantity,
            subtotal: subtotal.toFixed(2),
            serviceFee: SERVICE_FEE.toFixed(2),
            total: total.toFixed(2),
            orderId: purchaseResult.data.id
          };
          break;
          
        case 'info':
          const infoResponse = await axios.get(`${FAKE_STORE_API_URL}/products/${action.productId}`);
          result = {
            success: true,
            product: infoResponse.data
          };
          break;
          
        case 'search':
          let searchResults = [...products];
          
          // Filtra per categoria se specificata
          if (action.category) {
            searchResults = searchResults.filter(p => 
              p.category.toLowerCase().includes(action.category.toLowerCase())
            );
          }
          
          // Filtra per query di ricerca
          if (action.query) {
            const query = action.query.toLowerCase();
            searchResults = searchResults.filter(p => 
              p.title.toLowerCase().includes(query) ||
              p.description.toLowerCase().includes(query)
            );
          }
          
          result = {
            success: true,
            products: searchResults
          };
          break;
          
        default:
          result = {
            success: false,
            error: "Azione non riconosciuta"
          };
      }
      
      res.json({
        action,
        result,
        originalResponse: assistantResponse
      });
      
    } catch (parseError) {
      console.error('Errore nel parsing della risposta:', parseError);
      res.status(500).json({ 
        error: 'Non è stato possibile interpretare la richiesta',
        response: assistantResponse
      });
    }
  } catch (error) {
    console.error('Errore nella comunicazione con OpenAI:', error);
    res.status(500).json({ error: 'Errore nell\'elaborazione della richiesta' });
  }
});

// Endpoint per completare l'acquisto
app.post('/api/checkout', async (req, res) => {
  try {
    const { productId, quantity, paymentInfo } = req.body;
    
    // Ottieni dettagli prodotto
    const productResponse = await axios.get(`${FAKE_STORE_API_URL}/products/${productId}`);
    const product = productResponse.data;
    
    // Calcola il totale con commissione
    const subtotal = product.price * quantity;
    const total = subtotal + SERVICE_FEE;
    
    // Simula una chiamata API di pagamento
    // In una app reale, qui si integrerebbe Stripe, PayPal, ecc.
    const paymentResult = {
      success: true,
      transactionId: 'txn_' + Math.random().toString(36).substr(2, 9),
      amount: total,
      date: new Date()
    };
    
    // Crea un ordine nel Fake Store API
    const orderResponse = await axios.post(`${FAKE_STORE_API_URL}/orders`, {
      userId: 1,
      products: [{ productId, quantity }],
      date: new Date()
    });
    
    res.json({
      success: true,
      order: {
        id: orderResponse.data.id,
        product,
        quantity,
        subtotal: subtotal.toFixed(2),
        serviceFee: SERVICE_FEE.toFixed(2),
        total: total.toFixed(2)
      },
      payment: paymentResult
    });
  } catch (error) {
    console.error('Errore durante il checkout:', error);
    res.status(500).json({ error: 'Errore durante il processo di pagamento' });
  }
});

// Avvia il server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
