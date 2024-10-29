require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const json2csv = require('json2csv').Parser;
const sqlite3 = require('sqlite3').verbose();
const path = require('path'); 
const { body, validationResult } = require('express-validator');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const WebSocket = require('ws');
const http = require('http');
const multer = require('multer');
const upload = multer(); // for parsing multipart/form-data
const { exec } = require('child_process');
// Wrap your app with a HTTP server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const baseUrl = `https://185.koronacloud.com/web/api/v3/accounts/4f22ce39-0b59-47a5-b6d7-271cca691a45/receipts?voidedItems=false`;
const baseUrl2 = `https://185.koronacloud.com/web/api/v3/accounts/4f22ce39-0b59-47a5-b6d7-271cca691a45/products`;
const username = process.env.KORONACLOUD_USERNAME;
const password = process.env.KORONACLOUD_PASSWORD;

const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
app.use(bodyParser.urlencoded({ extended: true }));

//db logic:
// Create a new database file
let db = new sqlite3.Database('products.db', (err) => {
  if (err) {
    return console.error(err.message);
  }
  console.log('Connected to the SQLite database.');
});

// Create a table
db.run(`CREATE TABLE IF NOT EXISTS processed_products (
  product_code TEXT PRIMARY KEY,
  last_purchase_price REAL
)`, (err) => {
  if (err) {
    console.error(err.message);
  }
});

//Check and Log
const checkProductCode = (productNumber) => {
  return new Promise((resolve, reject) => {
    db.get(`SELECT last_purchase_price FROM processed_products WHERE product_code = ?`, [productNumber], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
};

const logProductCode = (productNumber, lastPurchasePrice) => {
  console.log(`Logging product code: ${productNumber} with price: ${lastPurchasePrice}`);
  db.run(`INSERT OR REPLACE INTO processed_products (product_code, last_purchase_price) VALUES (?, ?)`, [productNumber, lastPurchasePrice], (err) => {
    if (err) {
      console.error(`Error logging product code ${productNumber}: ${err.message}`);
    }else{
      console.log(`Product code ${productNumber} logged successfully.`);
    }
  });
};


const fetchDataFromPage = async (page, minBookingTime, maxBookingTime) => {
  try {
    const apiUrl = `${baseUrl}&minBookingTime=${encodeURIComponent(minBookingTime)}&maxBookingTime=${encodeURIComponent(maxBookingTime)}&page=${page}`;
    console.log(`Fetching data from page ${page}...`);
    const response = await axios.get(apiUrl, { headers: { Authorization: authHeader } });

    if (response.data && response.data.results && response.data.results.length > 0) {
      return { data: response.data.results, error: false };
    } else {
      console.log(`Data is missing in the response from page ${page}`);
      return { data: [], error: true };
    }
  } catch (error) {
    console.log(`Error fetching data from page ${page}: ${error.message}`);
    return { data: [], error: true };
  }
};

const processReceiptsToRows = async (receipts) => {
  const rows = [];
  for (const receipt of receipts) { 
    if (Array.isArray(receipt.items)) { 
      for (const item of receipt.items) { 
        const customer = receipt.customer || {}; // Ensure customer is an object
        const lastPurchasePrice = await retrieveLastPurchasePrice(item.product.number); // Await the async call
        const row = {
          cancelled: receipt.cancelled || "N/A",
          number: receipt.number || "N/A",
          bookingTime: receipt.bookingTime || "N/A",
          itemRecognitionNumber: item.recognitionNumber || "N/A",
          lastPurchasePrice: lastPurchasePrice, // The awaited last purchase price
          itemDescription: item.description || "N/A",
          itemQuantity: item.quantity || "N/A",
          itemTotalNet: item.total.net || "N/A",
          itemTotalGross: item.total.gross || "N/A",
          itemDiscountAmount: item.total.discount || "N/A",
          itemCommodityGroup: item.commodityGroup.name || "N/A",
          customerName: customer.name || "N/A",
          customerNumber: customer.number || "N/A",
        };
        rows.push(row);
      }
    }
  }
  return rows;
};

// Retrieve the last purchase price for a product
const retrieveLastPurchasePrice = async (productNumber) => {
  console.log(`Retrieving last purchase price for product code: ${productNumber}`);
  try {
    const productPriceData = await checkProductCode(productNumber);
    if (productPriceData) {
      return productPriceData.last_purchase_price;
    } else {
      const productUrl = `${baseUrl2}/${productNumber}`;
      const response = await axios.get(productUrl, { headers: { Authorization: authHeader } });
      const lastPurchasePrice = response.data.lastPurchasePrice;
      await logProductCode(productNumber, lastPurchasePrice);
      return lastPurchasePrice;
    }
  } catch (error) {
    console.error(`Error retrieving last purchase price for product ${productNumber}: ${error}`);
    return 'N/A';
  }
};

const sortRowsByReceiptNumber = (rows) => {
  return rows.sort((a, b) => {
    const numA = a.number.toUpperCase(); // assume number is a string
    const numB = b.number.toUpperCase(); 
    if (numA < numB) {
      return -1;
    }
    if (numA > numB) {
      return 1;
    }
    return 0;
  });
};

const writeCSV = (rows) => {
  const json2csvParser = new json2csv({
      fields: [
          'cancelled', 'number', 'bookingTime', 'itemRecognitionNumber', 'itemDescription',
          'itemQuantity', 'itemTotalNet', 'itemTotalGross', 'lastPurchasePrice', 'itemDiscountAmount', 'itemCommodityGroup', 'customerName', 'customerNumber',
      ],
      header: true,
      quote: '"',
      excelStrings: true
  });

  return json2csvParser.parse(rows);
};

const fetchAllData = async (startDate, endDate) => {
  const minBookingTime = `${startDate}T00:00:00-06:00`;
  const maxBookingTime = `${endDate}T23:59:59-06:00`;

  console.log('Starting data fetch process.');
  let page = 1;
  let consecutiveErrors = 0;
  let allRows = []; // Initialize an array to collect all rows

  while (true) {
      const { data, error } = await fetchDataFromPage(page, minBookingTime, maxBookingTime);
      if (data.length > 0) {
          let rows = await processReceiptsToRows(data);
          rows = sortRowsByReceiptNumber(rows);
          allRows.push(...rows); // Collect rows

          consecutiveErrors = 0;
      } else if (error) {
          console.log(`Error or no data on page ${page}. Continuing to the next page.`);
          consecutiveErrors++;
          if (consecutiveErrors >= 3) {
              console.log('Three consecutive errors. Exiting.');
              break;
          }
      } else {
          console.log(`No more data to fetch from page ${page}. Exiting.`);
          break;
      }

      page++;
  }

  return allRows; // Return the collected rows
};

// Listen on the HTTP server instead of the Express app directly
server.listen(3000, () => {
    console.log('Server running on port 3000, Navigate to /index.html');
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function ensureDirectoryExists(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
      ensureDirectoryExists(dirname);
      fs.mkdirSync(dirname, { recursive: true });
  }
}

function runJavaCommand(filePath) {
  const command = `java -jar /bin/workflow.jar --pretty --savePartialState -v ${filePath}`;
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Execution error: ${error}`);
      return;
    }
    console.log(`stdout: ${stdout}`);
    console.error(`stderr: ${stderr}`);
  });
}

// Route to handle POST requests
app.post('/submit-dates', upload.none(), async (req, res) => {
  try {
      const { start_date, end_date } = req.body;
      console.log(`Received dates: Start - ${start_date}, End - ${end_date}`);

      // Simple date validation
      const isValidDate = (dateStr) => {
          const regex = /^\d{4}-\d{2}-\d{2}$/; // Simple regex for 'YYYY-MM-DD'
          return regex.test(dateStr);
      };

      if (isValidDate(start_date) && isValidDate(end_date)) {
          const data = await fetchAllData(start_date, end_date);
          const csvData = writeCSV(data);
          const filePath = path.join(__dirname, '/', `receiptReportKindVape.csv`);

          console.log(`Attempting to save CSV at: ${filePath}`);
          ensureDirectoryExists(filePath);

          fs.writeFile(filePath, csvData, (err) => {
              if (err) {
                  console.error('Error saving the CSV file:', err);
                  res.status(500).send('Error saving file.');
              } else {
                  console.log('File saved successfully at:', filePath);
                  res.send('File saved successfully.');
              }
              runJavaCommand(filePath);
          });
      } else {
          console.log('Invalid date format provided.');
          res.status(400).send('Invalid start_date or end_date');
      }
  } catch (error) {
      console.error('Error processing request:', error);
      res.status(500).send('Failed to process request.');
  }
});