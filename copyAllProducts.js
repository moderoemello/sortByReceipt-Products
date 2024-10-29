const axios = require('axios');
const fs = require('fs');
const json2csv = require('json2csv').Parser;

const baseUrl = 'https://167.koronacloud.com/web/api/v3/accounts/dd0b749a-56f5-4185-a782-590230a8530f/products';
const username = 'support';
const password = 'support';
const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const fetchDataFromPage = async (page) => {
  try {
    const apiUrl = `${baseUrl}?page=${page}`;
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

const getColumns = (data) => {
  const columns = new Set();
  data.forEach((item) => {
    Object.keys(item).forEach((key) => {
      if (Array.isArray(item[key])) {
        item[key].forEach((subItem, index) => {
          Object.keys(subItem).forEach((subKey) => {
            // Check if the key is 'supplier' and it's within 'supplierPrices'
            if (key === 'supplierPrices' && subKey === 'supplier') {
              columns.add(`${key}[${index}].${subKey}.name`); // Add just the 'name' property path
            } else if (subKey === 'name') {
              columns.add(subItem[subKey]); // Add just the 'name' property value
            } else {
              columns.add(`${key}[${index}].${subKey}`);
            }
          });
        });
      } else if (typeof item[key] === 'object') {
        if (key === 'prices') {
          // Extract just the name property from the priceGroup object
          const priceGroupNames = item[key].map((priceGroup) => priceGroup.name);
          priceGroupNames.forEach((priceGroupName) => {
            columns.add(priceGroupName); // Add just the 'name' property value
          });
        } else {
          Object.keys(item[key]).forEach((subKey) => {
            columns.add(`${key}.${subKey}`);
          });
        }
      } else {
        columns.add(key);
      }
    });
  });
  return Array.from(columns);
};


const createWriteStream = () => {
  const writeStream = fs.createWriteStream('products.csv');
  return writeStream;
};

let allColumns = new Set();  // Declare this before fetchAllData function

const writeCSV = (data, writeStream, headersWritten) => {
  const columns = getColumns(data);
  columns.forEach(col => allColumns.add(col));  // Add new columns to the global set
  
  const json2csvParser = new json2csv({
    fields: Array.from(allColumns),  // Use the global set of columns
    header: !headersWritten,
    quote: '"',
    excelStrings: true
  });
  const csvData = json2csvParser.parse(data);
  writeStream.write(csvData + '\n');
};

const fetchAllData = async () => {
  let page = 1;
  let consecutiveErrors = 0;
  const writeStream = createWriteStream();

  // Variable to track if headers have been written to the CSV
  let headersWritten = false;

  while (true) {
    const { data, error } = await fetchDataFromPage(page);

    if (data.length > 0) {
      writeCSV(data, writeStream, headersWritten);
      // Update headersWritten to true after writing the first page of data
      if (!headersWritten) headersWritten = true;
      
      consecutiveErrors = 0;  // Reset error counter
    } else if (error) {
      console.log(`Error or no data on page ${page}. Writing CSV and continuing.`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {  // Exit if 3 consecutive errors
        console.log('Three consecutive errors. Exiting.');
        break;
      }
    } else {
      console.log(`No more data to fetch from page ${page}. Exiting.`);
      break;
    }

    page++;
  }

  writeStream.end();
};


fetchAllData();
