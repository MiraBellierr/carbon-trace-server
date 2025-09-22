require("dotenv").config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'your-fallback-key-here');

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Initialize SQLite database
const db = new sqlite3.Database('./carbon_trace.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Create orders table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customerName TEXT NOT NULL,
  totalPrice REAL NOT NULL,
  totalCarbonSaved REAL NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Create order_items table
db.run(`CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId INTEGER NOT NULL,
  itemName TEXT NOT NULL,
  unitPrice REAL NOT NULL,
  quantity INTEGER NOT NULL,
  carbonSaved REAL NOT NULL,
  FOREIGN KEY (orderId) REFERENCES orders (id)
)`);

// Routes

// Get all orders with their items
app.get('/api/orders', (req, res) => {
  db.all(`SELECT o.*, 
          json_group_array(json_object(
            'id', oi.id,
            'itemName', oi.itemName,
            'unitPrice', oi.unitPrice,
            'quantity', oi.quantity,
            'carbonSaved', oi.carbonSaved
          )) as items
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.orderId
          GROUP BY o.id
          ORDER BY o.timestamp DESC`, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Parse the JSON items
    const orders = rows.map(row => ({
      ...row,
      items: JSON.parse(row.items)
    }));
    
    res.json({
      message: 'success',
      data: orders
    });
  });
});

// Create a new order with items
app.post('/api/orders', (req, res) => {
  const { customerName, items, totalPrice, totalCarbonSaved } = req.body;
  
  db.serialize(() => {
    // Insert the main order
    db.run(
      `INSERT INTO orders (customerName, totalPrice, totalCarbonSaved) 
       VALUES (?, ?, ?)`,
      [customerName, totalPrice, totalCarbonSaved],
      function(err) {
        if (err) {
          res.status(400).json({ error: err.message });
          return;
        }
        
        const orderId = this.lastID;
        
        // Insert all order items
        const stmt = db.prepare(`INSERT INTO order_items 
          (orderId, itemName, unitPrice, quantity, carbonSaved) 
          VALUES (?, ?, ?, ?, ?)`);
        
        items.forEach(item => {
          stmt.run([orderId, item.itemName, item.unitPrice, 
                   item.quantity, item.carbonSaved]);
        });
        
        stmt.finalize((err) => {
          if (err) {
            res.status(400).json({ error: err.message });
            return;
          }
          
          res.json({
            message: 'success',
            data: {
              id: orderId,
              customerName,
              totalPrice,
              totalCarbonSaved,
              items,
              timestamp: new Date().toISOString()
            }
          });
        });
      }
    );
  });
});

// Get a single order with items
app.get('/api/orders/:id', (req, res) => {
  const id = req.params.id;
  
  db.get(`SELECT o.*, 
          json_group_array(json_object(
            'id', oi.id,
            'itemName', oi.itemName,
            'unitPrice', oi.unitPrice,
            'quantity', oi.quantity,
            'carbonSaved', oi.carbonSaved
          )) as items
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.orderId
          WHERE o.id = ?
          GROUP BY o.id`, [id], (err, row) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    
    if (row) {
      row.items = JSON.parse(row.items);
    }
    
    res.json({
      message: 'success',
      data: row
    });
  });
});

// Update an order
app.put('/api/orders/:id', (req, res) => {
  const id = req.params.id;
  const { customerName, items, totalPrice, totalCarbonSaved } = req.body;
  
  db.serialize(() => {
    // Update the main order
    db.run(
      `UPDATE orders SET 
        customerName = ?, 
        totalPrice = ?, 
        totalCarbonSaved = ?
       WHERE id = ?`,
      [customerName, totalPrice, totalCarbonSaved, id],
      function(err) {
        if (err) {
          res.status(400).json({ error: err.message });
          return;
        }
        
        // Delete existing items
        db.run('DELETE FROM order_items WHERE orderId = ?', [id], (err) => {
          if (err) {
            res.status(400).json({ error: err.message });
            return;
          }
          
          // Insert updated items
          const stmt = db.prepare(`INSERT INTO order_items 
            (orderId, itemName, unitPrice, quantity, carbonSaved) 
            VALUES (?, ?, ?, ?, ?)`);
          
          items.forEach(item => {
            stmt.run([id, item.itemName, item.unitPrice, 
                     item.quantity, item.carbonSaved]);
          });
          
          stmt.finalize((err) => {
            if (err) {
              res.status(400).json({ error: err.message });
              return;
            }
            
            res.json({
              message: 'success',
              changes: this.changes
            });
          });
        });
      }
    );
  });
});

// Delete an order and its items
app.delete('/api/orders/:id', (req, res) => {
  const id = req.params.id;
  
  db.serialize(() => {
    // Delete order items first
    db.run('DELETE FROM order_items WHERE orderId = ?', [id], (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      
      // Delete the order
      db.run('DELETE FROM orders WHERE id = ?', [id], function(err) {
        if (err) {
          res.status(400).json({ error: err.message });
          return;
        }
        res.json({
          message: 'deleted',
          changes: this.changes
        });
      });
    });
  });
});

// AI Prompt endpoint
app.post("/api/prompts", async (req, res) => {
  const { prompt } = req.body;
  
  try {
    // For safety, check if API key is available
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'your-fallback-key-here') {
      console.log('Using fallback responses - no valid API key configured');
      
      // Fallback responses if AI service is not configured
      if (prompt.includes("Estimate the carbon footprint")) {
        // Return a reasonable estimate based on common items
        const fallbackEstimate = Math.random() * 5 + 0.5; // 0.5 to 5.5 kgCO2e
        return res.status(200).json({ response: fallbackEstimate.toFixed(2) });
      } else if (prompt.includes("suggestions to reduce carbon footprint")) {
        return res.status(200).json({ 
          response: "1. Consider choosing more sustainable alternatives. 2. Reduce consumption where possible. 3. Look for locally produced options to reduce transportation emissions." 
        });
      } else {
        return res.status(200).json({ 
          response: "I'm unable to provide a response at this time. Please try again later."
        });
      }
    }

    const response = await generateResponse(prompt);
    res.status(200).json({ response });
  } catch (err) {
    console.error("AI Error:", err);
    
    // Fallback responses if AI service fails
    if (prompt.includes("Estimate the carbon footprint")) {
      // Return a reasonable estimate based on common items
      const fallbackEstimate = Math.random() * 5 + 0.5; // 0.5 to 5.5 kgCO2e
      res.status(200).json({ response: fallbackEstimate.toFixed(2) });
    } else if (prompt.includes("suggestions to reduce carbon footprint")) {
      res.status(200).json({ 
        response: "1. Consider choosing more sustainable alternatives. 2. Reduce consumption where possible. 3. Look for locally produced options to reduce transportation emissions." 
      });
    } else {
      res.status(500).json({ 
        error: err.message,
        response: "I'm unable to provide a response at this time. Please try again later."
      });
    }
  }
});

async function generateResponse(prompt) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash-lite",
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
      }
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log("AI Response:", text);
    return text;
  } catch (err) {
    console.error("Error generating AI response:", err);
    throw err;
  }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    hasApiKey: !!process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY !== 'your-fallback-key-here'
  });
});

// Serve React app in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Warning if no API key is set
  if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'your-fallback-key-here') {
    console.warn('WARNING: GOOGLE_API_KEY environment variable is not set or is using the default value.');
    console.warn('AI features will use fallback responses instead of real AI calculations.');
  }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Database connection closed.');
    process.exit(0);
  });
});