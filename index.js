import express, { json } from 'express';
import { config } from 'dotenv';
import { WebhookClient } from 'dialogflow-fulfillment';
import { connectDB, getDB } from './Config/DatabaseConfig.js';



config();
await connectDB();

const app = express();
app.use(json());


app.use(express.json());

app.post('/webhook', (req, res) => {
  try {
    const dialogflowRequest = req.body;
    const intentName = dialogflowRequest.queryResult.intent.displayName;
    const parameters = dialogflowRequest.queryResult.parameters;

    let responseText = 'Webhook received!';
    if (intentName === 'TestIntent') {
      const userName = parameters.name || 'Guest';
      responseText = `Hello ${userName}, this is a test response from webhook!`;
    }

    // Định dạng response cho Dialogflow
    const dialogflowResponse = {
      fulfillmentMessages: [
        {
          text: {
            text: [responseText]
          }
        }
      ]
    };

    res.status(200).json(dialogflowResponse);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      fulfillmentMessages: [
        {
          text: {
            text: ['Error occurred, please try again!']
          }
        }
      ]
    });
  }
});

app.get('/', (req, res) => {
  res.status(200).json({ status: 'Webhook server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Local server listening on port 3000');

});