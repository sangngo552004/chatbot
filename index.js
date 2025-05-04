import express, { json } from 'express';
import { config } from 'dotenv';
import { WebhookClient } from 'dialogflow-fulfillment';
import { connectDB, getDB } from './Config/DatabaseConfig.js';

config();
await connectDB();

const app = express();
app.use(json());
app.use(express.json());

// --- Hàm xử lý Intents ---
let db = getDB() ; 
const DB_NAME =  ""
const CONCEPTS_COLLECTION = 'concepts';

function extractSessionInfo(sessionPath) {
  // sessionPath format: "projects/<ProjectID>/agent/sessions/<SessionID>"
  // hoặc "projects/<ProjectID>/agent/environments/<EnvironmentID>/users/<UserID>/sessions/<SessionID>"
  const match = sessionPath.match(/projects\/([^/]+)\/(?:agent\/)?(?:environments\/[^/]+\/users\/[^/]+\/)?sessions\/([^/]+)/);
  if (match && match[1] && match[2]) {
      return { projectId: match[1], sessionId: match[2] };
  }
  console.warn("Could not extract ProjectID and SessionID from session path:", sessionPath);
  return { projectId: process.env.DIALOGFLOW_PROJECT_ID || '<YOUR_PROJECT_ID>', sessionId: sessionPath }; // Dự phòng
}

async function findConcept(conceptParam, conceptsCollection) {
  if (!conceptParam) return null;
  // Chuẩn hóa đầu vào: chuyển về chữ thường, loại bỏ khoảng trắng thừa
  const searchTerm = String(conceptParam).toLowerCase().trim();

  // Cố gắng tìm chính xác trước, sau đó tìm gần đúng
  // Ưu tiên khớp concept_id hoặc aliases trước (toàn bộ chuỗi, không phân biệt hoa thường)
   let conceptDoc = await conceptsCollection.findOne({
       $or: [
           { concept_id: { $regex: `^${searchTerm}$`, $options: 'i' } },
           { aliases: { $regex: `^${searchTerm}$`, $options: 'i' } },
       ]
   });

  // Nếu không tìm thấy khớp chính xác, thử tìm trong tên (chứa chuỗi, không phân biệt hoa thường)
  if (!conceptDoc) {
      conceptDoc = await conceptsCollection.findOne({
           name: { $regex: searchTerm, $options: 'i' }
      });
  }
  return conceptDoc;
}

async function handleAskDefinition(parameters) {
  console.log("2")
  const defaultResponse = "Xin lỗi, bạn muốn hỏi về khái niệm nào?";
  if (!parameters || !parameters.concept) {
      return { responseText: defaultResponse, conceptFound: null };
  }

  const conceptParam = parameters.concept;
  try {
      const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
      const conceptDoc = await findConcept(conceptParam, conceptsCollection);

      if (conceptDoc && conceptDoc.definition) {
          const responseText = `${conceptDoc.name || conceptParam}:\n${conceptDoc.definition}`;
          // Trả về cả conceptDoc để biết cần đặt context hay không và đặt giá trị gì
          return { responseText: responseText, conceptFound: conceptDoc };
      } else {
          return { responseText: `Xin lỗi, tôi chưa tìm thấy định nghĩa cho "${conceptParam}".`, conceptFound: null };
      }
  } catch (error) {
      console.error("Error querying definition:", error);
      return { responseText: "Đã có lỗi xảy ra khi tìm định nghĩa.", conceptFound: null };
  }
}

async function handleAskComparison(parameters) {
   const defaultResponse = "Xin lỗi, bạn muốn so sánh giữa hai khái niệm nào?";
  if (!parameters || !parameters.concept1 || !parameters.concept2) {
      return { responseText: defaultResponse };
  }

  const concept1Param = parameters.concept1;
  const concept2Param = parameters.concept2;

  try {
      const conceptsCollection = db.collection(CONCEPTS_COLLECTION);

      // Hàm tìm kiếm nội dung so sánh trong một document
      const findComparisonText = (doc, targetConcept) => {
          if (!doc || !doc.comparison_points) return null;
          const targetLower = String(targetConcept).toLowerCase().trim();
          const comparison = doc.comparison_points.find(cp =>
              (cp.compare_with_concept_id && String(cp.compare_with_concept_id).toLowerCase().trim() === targetLower) ||
              (cp.compare_with_name && String(cp.compare_with_name).toLowerCase().includes(targetLower))
          );
          return comparison ? comparison.comparison_text : null;
      };

      // Tìm trong concept1
      const concept1Doc = await findConcept(concept1Param, conceptsCollection);
      let comparisonText = findComparisonText(concept1Doc, concept2Param);

      // Nếu không thấy, tìm trong concept2
      if (!comparisonText) {
          const concept2Doc = await findConcept(concept2Param, conceptsCollection);
          comparisonText = findComparisonText(concept2Doc, concept1Param); // So sánh ngược lại
      }

      if (comparisonText) {
          return { responseText: comparisonText };
      } else {
           return { responseText: `Xin lỗi, tôi chưa có thông tin so sánh trực tiếp giữa "${concept1Param}" và "${concept2Param}".` };
      }

  } catch (error) {
      console.error("Error querying comparison:", error);
      return { responseText: "Đã có lỗi xảy ra khi tìm thông tin so sánh." };
  }
}

// Xử lý Intent: AskExample
// Trả về object { responseText: string }
async function handleAskExample(parameters) {
  const defaultResponse = "Xin lỗi, bạn muốn xem ví dụ về khái niệm nào?";
  // Parameter 'concept' sẽ được điền từ user input hoặc từ context (nếu cấu hình Default Value)
  if (!parameters || !parameters.concept) {
      return { responseText: defaultResponse };
  }

  const conceptParam = parameters.concept;

  try {
      const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
      const conceptDoc = await findConcept(conceptParam, conceptsCollection);

      if (conceptDoc && conceptDoc.examples && conceptDoc.examples.length > 0) {
          // Lấy ví dụ đầu tiên hoặc định dạng nhiều ví dụ
          const exampleText = conceptDoc.examples
              .slice(0, 2) // Lấy tối đa 2 ví dụ
              .map(ex => `- ${ex.content}`)
              .join('\n'); // Nối các ví dụ bằng xuống dòng

          return { responseText: `Đây là ví dụ về ${conceptDoc.name || conceptParam}:\n${exampleText}` };
      } else {
          return { responseText: `Xin lỗi, tôi chưa tìm thấy ví dụ nào cho "${conceptParam}".` };
      }
  } catch (error) {
      console.error("Error querying example:", error);
      return { responseText: "Đã có lỗi xảy ra khi tìm ví dụ." };
  }
}


// --- Endpoint Webhook Chính ---
app.post('/webhook', async (req, res) => {
  // Đảm bảo đã kết nối DB
  if (!db) {
      await connectDB();
  }
  if (!db) {
      return res.status(500).json({ fulfillmentText: "Lỗi kết nối cơ sở dữ liệu." });
  }

  const queryResult = req.body.queryResult;
  const sessionPath = req.body.session; // Lấy session path từ request
  const intentName = queryResult.intent.displayName;
  const parameters = queryResult.parameters;

  console.log(`[${new Date().toISOString()}] Intent: ${intentName}, Session: ${sessionPath}`);
  // console.log(`Parameters: ${JSON.stringify(parameters)}`);

  let handlerResult = { responseText: "Xin lỗi, tôi chưa hiểu ý bạn." }; // Mặc định
  let outputContexts = []; // Mảng chứa các output contexts cần thiết lập

  try {
      switch (intentName) {
          case 'AskDefinition':
              console.log("1");
              handlerResult = await handleAskDefinition(parameters);
              // Nếu tìm thấy định nghĩa, thiết lập output context
              if (handlerResult.conceptFound) {
                  const sessionInfo = extractSessionInfo(sessionPath);
                  const contextName = `projects/${sessionInfo.projectId}/agent/sessions/${sessionInfo.sessionId}/contexts/context_concept_defined`;
                  outputContexts.push({
                      name: contextName,
                      lifespanCount: 2, // Số lượt context tồn tại
                      parameters: {
                          // Gửi concept_id hoặc tên chuẩn để đảm bảo tính nhất quán
                          concept: handlerResult.conceptFound.concept_id || handlerResult.conceptFound.name
                      }
                  });
                  console.log(`Setting Output Context: ${contextName} with concept: ${handlerResult.conceptFound.concept_id || handlerResult.conceptFound.name}`);
              }
              break;
          case 'AskComparison':
              handlerResult = await handleAskComparison(parameters);
              break;
          case 'AskExample_FollowUp':
              // Logic xử lý đã bao gồm việc lấy concept từ context (nếu được cấu hình trong Dialogflow)
              handlerResult = await handleAskExample(parameters);
              break;
          default:
              console.log(`Intent ${intentName} không được xử lý bởi webhook này.`);
              handlerResult.responseText = `Tôi chưa được lập trình để xử lý yêu cầu này (${intentName}).`;
      }
  } catch (error) {
      console.error(`Error handling intent ${intentName}:`, error);
      handlerResult.responseText = "Đã có lỗi xảy ra trong quá trình xử lý yêu cầu của bạn.";
  }


  // --- Gửi phản hồi về Dialogflow ---
  const responseJson = {
      fulfillmentMessages: [{ text: { text: [handlerResult.responseText] } }],
      outputContexts: outputContexts // Thêm mảng output contexts vào phản hồi
  };

  console.log("--- Sending Response to Dialogflow ---");
  console.log(JSON.stringify(responseJson, null, 2));
  console.log("------------------------------------");

  res.json(responseJson);
});


app.get('/', (req, res) => {
  res.status(200).json({ status: 'Webhook server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Local server listening on port 3000');

});