// index.js
const express = require('express');
const AWS = require('aws-sdk');
const cors = require('cors');
const serverless = require('serverless-http');

const app = express();

AWS.config.update({ region: 'us-east-1' });

const comprehend = new AWS.Comprehend();

// In-memory storage for demo (use DynamoDB in production)
let dailyExpenses = [];
let currentCurrency = 'USD'; // Default currency

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Extract expense using AWS Comprehend + pattern matching
async function extractExpenseWithAI(text) {
  try {
    // Use AWS Comprehend to detect entities
    const comprehendParams = {
      Text: text,
      LanguageCode: 'en'
    };
    
    const entities = await comprehend.detectEntities(comprehendParams).promise();
    const sentiment = await comprehend.detectSentiment(comprehendParams).promise();
    
    // Extract amount and currency using patterns (more reliable for numbers)
    const { amount, currency } = extractAmountAndCurrency(text);
    
    // Use Comprehend entities + patterns for category
    let category = extractCategory(text, entities.Entities);
    
    return {
      amount,
      currency,
      category,
      confidence: entities.Entities.length > 0 ? 'high' : 'medium',
      sentiment: sentiment.Sentiment,
      entities: entities.Entities.map(e => ({ text: e.Text, type: e.Type, score: e.Score }))
    };
  } catch (error) {
    console.error('Comprehend error:', error);
    // Fallback to pattern matching
    return extractExpenseFallback(text);
  }
}

// Extract amount and currency using regex patterns
function extractAmountAndCurrency(text) {
  const patterns = [
    // Explicit currency patterns
    /(\d{1,3}(?:,\d{3})*|\d+)\s*(naira|₦)/i,
    /(\d{1,3}(?:,\d{3})*|\d+)\s*(dollars?|\$|usd)/i,
    // Action patterns
    /(?:spent|paid|cost)\s*(\d{1,3}(?:,\d{3})*|\d+)\s*(naira|₦|dollars?|\$|usd)?/i,
    // General patterns
    /(\d{1,3}(?:,\d{3})*|\d+)\s*(?:on|for)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const amount = match[1].replace(/,/g, '');
      const currencyText = match[1];
      
      let detectedCurrency = currentCurrency; // Default to current
      if (currencyText) {
        if (/dollars?|\$|usd/i.test(currencyText)) {
          detectedCurrency = 'USD';
        }
      }
      
      return { amount, currency: detectedCurrency };
    }
  }
  return { amount: null, currency: currentCurrency };
}

// Extract category using Comprehend entities + patterns
function extractCategory(text, entities) {
  // First try Comprehend entities
  const relevantEntities = entities.filter(e => 
    ['OTHER', 'COMMERCIAL_ITEM', 'ORGANIZATION'].includes(e.Type) && e.Score > 0.7
  );
  
  if (relevantEntities.length > 0) {
    return relevantEntities[0].Text.toLowerCase();
  }
  
  // Fallback to pattern matching
  const categoryPatterns = [
    /(?:on|for)\s+(\w+)/i,
    /(?:naira|₦|dollars?|\$)\s+(\w+)/i,
    /(food|transport|fuel|groceries|shopping|entertainment|bills|rent|utilities)/i
  ];
  
  for (const pattern of categoryPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  
  return null;
}

// Fallback extraction without AI
function extractExpenseFallback(text) {
  const { amount, currency } = extractAmountAndCurrency(text);
  
  const categoryPatterns = [
    /(?:on|for)\s+(\w+)/i,
    /(?:naira|₦|dollars?|\$)\s+(\w+)/i,
    /(food|transport|fuel|groceries|shopping|entertainment|bills|rent|utilities)/i
  ];
  
  let category = null;
  for (const pattern of categoryPatterns) {
    const match = text.match(pattern);
    if (match) {
      category = match[1].toLowerCase();
      break;
    }
  }
  
  return { amount, currency, category, confidence: 'low' };
}

// Helper functions for daily tracking
function getDailyTotal(currency = currentCurrency) {
  const today = new Date().toDateString();
  return dailyExpenses
    .filter(e => new Date(e.timestamp).toDateString() === today && e.currency === currency)
    .reduce((sum, e) => sum + parseInt(e.amount || 0), 0);
}

function getTodayExpenses(currency = currentCurrency) {
  const today = new Date().toDateString();
  return dailyExpenses
    .filter(e => new Date(e.timestamp).toDateString() === today && e.currency === currency)
    .slice(-5); // Last 5 expenses
}

function getCurrencySymbol(currency) {
  return currency === 'NGN' ? '₦' : '$';
}

// Process speech text directly
app.post('/process-speech', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  
  const extracted = await extractExpenseWithAI(text);
  
  // Save expense if valid (in-memory only for demo)
  if (extracted.amount && extracted.category) {
    const expense = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      transcript: text,
      ...extracted
    };
    dailyExpenses.push(expense);
  }
  
  res.json({
    transcript: text,
    ...extracted,
    dailyTotal: getDailyTotal(extracted.currency),
    todayExpenses: getTodayExpenses(extracted.currency),
    currencySymbol: getCurrencySymbol(extracted.currency || currentCurrency)
  });
});

// Set currency preference
app.post('/set-currency', (req, res) => {
  const { currency } = req.body;
  if (['USD', 'NGN'].includes(currency)) {
    currentCurrency = currency;
    res.json({ 
      success: true, 
      currency: currentCurrency,
      currencySymbol: getCurrencySymbol(currentCurrency)
    });
  } else {
    res.status(400).json({ error: 'Invalid currency. Use USD or NGN' });
  }
});

// Get daily summary
app.get('/daily-summary', (req, res) => {
  const currency = req.query.currency || currentCurrency;
  const today = new Date().toDateString();
  const todayExpenses = dailyExpenses.filter(e => 
    new Date(e.timestamp).toDateString() === today && e.currency === currency
  );
  
  const categoryTotals = todayExpenses.reduce((acc, expense) => {
    const category = expense.category || 'other';
    acc[category] = (acc[category] || 0) + parseInt(expense.amount || 0);
    return acc;
  }, {});
  
  res.json({
    totalExpenses: todayExpenses.length,
    dailyTotal: getDailyTotal(currency),
    categoryBreakdown: categoryTotals,
    recentExpenses: todayExpenses.slice(-10),
    currency: currency,
    currencySymbol: getCurrencySymbol(currency)
  });
});

// Export expenses as CSV
app.get('/export-csv', (req, res) => {
  const currency = req.query.currency || 'USD';
  const filteredExpenses = dailyExpenses.filter(e => e.currency === currency);
  
  const csv = filteredExpenses.map(e => 
    `"${e.timestamp}","${e.amount}","${e.currency}","${e.category}","${e.transcript.replace(/"/g, '""')}"`
  ).join('\n');
  
  const header = 'Date,Amount,Currency,Category,Description\n';
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=expenses-${currency}-${new Date().toISOString().split('T')[0]}.csv`);
  res.send(header + csv);
});

// Export for serverless deployment
module.exports = app;
module.exports.handler = serverless(app);

// For local development
if (require.main === module) {
  app.listen(3000, () => console.log('🚀 Voice Expense Tracker ready at http://localhost:3000'));
}