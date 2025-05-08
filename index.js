import express from 'express';
import { config } from 'dotenv';
import { WebhookClient } from 'dialogflow-fulfillment';
import { connectDB, getDB } from './Config/DatabaseConfig.js';
import { v4 as uuidv4 } from 'uuid';
import { ObjectId } from 'mongodb';

config();
await connectDB();

const app = express();
app.use(express.json());

// --- Hàm xử lý Intents ---
let db = getDB() ; 
const CONCEPTS_COLLECTION = 'concepts';
const QUESTIONS_COLLECTION = 'questions';

// --- Hàm Trợ giúp ---
function extractSessionInfo(sessionPath) {
    // ... (Giữ nguyên) ...
    const match = sessionPath.match(/projects\/([^/]+)\/(?:agent\/)?(?:environments\/[^/]+\/users\/[^/]+\/)?sessions\/([^/]+)/);
    if (match && match[1] && match[2]) {
        return { projectId: match[1], sessionId: match[2] };
    }
    console.warn("Could not extract ProjectID and SessionID from session path:", sessionPath);
    return { projectId: process.env.DIALOGFLOW_PROJECT_ID || '<YOUR_PROJECT_ID>', sessionId: sessionPath };
}

function buildContextName(projectId, sessionId, contextId) {
    // ... (Giữ nguyên) ...
    return `projects/${projectId}/agent/sessions/${sessionId}/contexts/${contextId}`;
}

async function findConcept(conceptParam, conceptsCollection) {
    // ... (Giữ nguyên) ...
     if (!conceptParam) return null;
     const searchTerm = String(conceptParam).toLowerCase().trim();
     let conceptDoc = await conceptsCollection.findOne({
         $or: [
             { concept_id: { $regex: `^${searchTerm}$`, $options: 'i' } },
             { aliases: { $regex: `^${searchTerm}$`, $options: 'i' } },
         ]
     });
     if (!conceptDoc) {
         conceptDoc = await conceptsCollection.findOne({
              name: { $regex: searchTerm, $options: 'i' }
         });
     }
     return conceptDoc;
}

async function getRandomQuestions(params, questionsCollection) {
    // ... (Giữ nguyên, nhưng đảm bảo lấy đủ thông tin cần cho context) ...
    const { number, topic, difficulty, concept } = params;
    const numQuestions = parseInt(number, 10) || 10; // Mặc định 10 câu

    const query = {};
    if (topic) query.topic = topic;
    if (difficulty) query.difficulty = difficulty;
     if (concept) {
          query.$or = [
              { sub_topic: { $regex: `^${String(concept)}$`, $options: 'i' } }
          ];
     }
     query.type = "multiple_choice";

    console.log("Querying questions with:", query);
    try {
        const questions = await questionsCollection.aggregate([
            { $match: query },
            { $sample: { size: numQuestions } }
        ]).toArray();
        console.log(questions);
         // Lấy đủ các trường cần thiết
         const detailedQuestions = questions.map(q => ({
              question_id: q._id,
              content: q.content,
              options: q.options,
              correct_answer: q.correct_answer,
              explanation: q.explanation,
              user_answer: null, // Thêm trường để lưu câu trả lời trong context
              is_correct: null   // Thêm trường để lưu kết quả trong context
         }));
        console.log(`Found ${detailedQuestions.length} questions.`);
        return detailedQuestions;
    } catch (error) {
        console.error("Error fetching random questions:", error);
        return [];
    }
}

async function getQuestionDetails(questionId, questionsCollection) {
    // ... (Giữ nguyên) ...
    try {
        const question = await questionsCollection.findOne({ question_id: questionId });
        return question;
    } catch (error) {
        console.error("Error fetching question details:", error);
        return null;
    }
}

// LOẠI BỎ các hàm createTestSession, getTestSession, updateTestSession, saveTestResultToUser

// --- Hàm xử lý cho từng Intent ---

// Nhóm 1: Lý thuyết (Giữ nguyên hoặc chỉnh sửa như code trước)
// Nhóm 1: Lý thuyết
async function handleAskDefinition(parameters, sessionPath, explainationDetailed = false) {
    const result = { responseText: "Xin lỗi, tôi chưa hiểu ý bạn.", outputContexts: [] };
    // parameters.concept có thể là một mảng các concepts nếu người dùng hỏi nhiều
    const conceptsArray = (parameters.concept && Array.isArray(parameters.concept))
                        ? parameters.concept
                        : (parameters.concept ? [parameters.concept] : []); // Đảm bảo luôn là mảng

    if (conceptsArray.length === 0) {
        result.responseText = "Xin lỗi, bạn muốn hỏi về khái niệm nào?";
        return result;
    }

    console.log("Handling AskDefinition for concepts:", conceptsArray.join(", "));
    let allDefinitions = [];
    let primaryConceptForContext = null; // Sẽ dùng concept đầu tiên cho context

    try {
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);

        for (let i = 0; i < conceptsArray.length; i++) {
            const conceptParam = conceptsArray[i]; // Xử lý từng concept trong mảng
            const conceptDoc = await findConcept(conceptParam, conceptsCollection); // findConcept nhận string

            if (conceptDoc && conceptDoc.definition) {
                let definitionText = `${conceptDoc.name || conceptParam}:\n${conceptDoc.definition}`;
                if (conceptDoc.explanation_detailed && explainationDetailed) {
                    definitionText = `${conceptDoc.explanation_detailed}`;
                }
                allDefinitions.push(definitionText);

                if (i === 0) { // Lấy concept đầu tiên để đặt context
                    primaryConceptForContext = conceptDoc.concept_id || conceptDoc.name || conceptParam;
                }
            } else {
                allDefinitions.push(`Xin lỗi, tôi chưa tìm thấy định nghĩa cho "${conceptParam}".`);
                if (i === 0) {
                     primaryConceptForContext = conceptParam; // Vẫn đặt context với concept người dùng hỏi
                }
            }
        }

        if (allDefinitions.length > 0) {
            result.responseText = allDefinitions.join("\n\n---\n\n"); // Ngăn cách các định nghĩa

            // Chỉ đặt context cho concept chính (đầu tiên) nếu có
            if (primaryConceptForContext) {
                const sessionInfo = extractSessionInfo(sessionPath);
                // QUAN TRỌNG: Sử dụng tên context nhất quán, ví dụ 'concept_followup'
                const contextId = 'concept_followup';
                const contextFullName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, contextId);

                result.outputContexts.push({
                    name: contextFullName,
                    lifespanCount: 3, // Tăng lifespan để hỗ trợ các câu hỏi nối tiếp
                    parameters: {
                        concept: primaryConceptForContext // Lưu concept chính vào context
                    }
                });
                console.log(`Setting Output Context: ${contextFullName} with primary concept: ${primaryConceptForContext}`);
            }
        } else {
            // Trường hợp này ít xảy ra nếu conceptsArray không rỗng ban đầu
            result.responseText = "Xin lỗi, tôi không thể tìm thấy thông tin cho các khái niệm bạn yêu cầu.";
        }

    } catch (error) {
        console.error("Error querying definition(s):", error);
        result.responseText = "Đã có lỗi xảy ra khi tìm định nghĩa.";
    }
    return result;
}


async function handleAskComparison(parameters) {
    const result = { responseText: "Xin lỗi, tôi chưa hiểu ý bạn.", outputContexts: [] };
    console.log(parameters)
    const defined_concept = parameters.defined_concept;
    const concepts = parameters.concept;
    let concept1, concept2;
    if (defined_concept && concepts.length === 1) {
        concept1 = defined_concept;
        concept2 = concepts;
    } else {
        concept1 = concepts[0];
        concept2 = concepts[1];
    }


    if (!concept1 || !concept2) {
        result.responseText = "Xin lỗi, bạn muốn so sánh giữa hai khái niệm nào?";
        return result;
    }

    try {
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
        const findComparisonText = (doc, targetConcept) => {
            if (!doc || !doc.comparison_points) return null;
            const targetLower = String(targetConcept).toLowerCase().trim();
            const comparison = doc.comparison_points.find(cp =>
                (cp.compare_with_concept && String(cp.compare_with_concept).toLowerCase().trim() === targetLower)
            );
            return comparison ? comparison.comparison_text : null;
        };

        const concept1Doc = await findConcept(concept1, conceptsCollection);
        let comparisonText = findComparisonText(concept1Doc, concept2);

        if (!comparisonText) {
            const concept2Doc = await findConcept(concept2, conceptsCollection);
            comparisonText = findComparisonText(concept2Doc, concept1);
        }

        if (comparisonText) {
            result.responseText = comparisonText;
        } else {
            result.responseText = `Xin lỗi, tôi chưa có thông tin so sánh trực tiếp giữa "${concept1}" và "${concept2}".`;
        }
    } catch (error) {
        console.error("Error querying comparison:", error);
        result.responseText = "Đã có lỗi xảy ra khi tìm thông tin so sánh.";
    }
     return result;
}

async function handleAskExample(parameters) {
    const result = { responseText: "Xin lỗi, tôi chưa hiểu ý bạn.", outputContexts: [] };
    const conceptParam = parameters.concept;
    const exampleTypeParam = parameters.example_type;

    if (!conceptParam) {
        result.responseText = "Xin lỗi, bạn muốn xem ví dụ về khái niệm nào?";
        return result;
    }

    try {
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
        const conceptDoc = await findConcept(conceptParam, conceptsCollection);

        if (conceptDoc && conceptDoc.examples && conceptDoc.examples.length > 0) {
            let examplesToReturn = conceptDoc.examples;

            // Lọc theo loại ví dụ nếu người dùng yêu cầu
            if (exampleTypeParam) {
                const filteredExamples = examplesToReturn.filter(ex => String(ex.type).toLowerCase() === String(exampleTypeParam).toLowerCase());
                if (filteredExamples.length > 0) {
                    examplesToReturn = filteredExamples;
                } else {
                     result.responseText = `Tôi không có ví dụ loại "${exampleTypeParam}" cho "${conceptDoc.name || conceptParam}". Đây là các ví dụ khác:\n`;
                }
            }

            const exampleText = examplesToReturn.slice(0, 2) // Lấy tối đa 2 ví dụ
                .map(ex => `- ${ex.content}`)
                .join('\n');

             if (result.responseText.startsWith("Tôi không có ví dụ loại")) {
                 result.responseText += exampleText;
             } else {
                 result.responseText = `Đây là ví dụ về ${conceptDoc.name || conceptParam}:\n${exampleText}`;
             }

        } else {
            result.responseText = `Xin lỗi, tôi chưa tìm thấy ví dụ nào cho "${conceptParam}".`;
        }
    } catch (error) {
        console.error("Error querying example:", error);
        result.responseText = "Đã có lỗi xảy ra khi tìm ví dụ.";
    }
     return result;
}


// Nhóm 4: Danh sách câu hỏi (Giữ nguyên logic dùng context)
async function handleRequestQuestionList(parameters, sessionPath) {
    const result = { responseText: "Có lỗi khi lấy danh sách câu hỏi.", outputContexts: [] };
    try {
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        // Đảm bảo hàm getRandomQuestions lấy cả trường 'options' từ CSDL
        const questions = await getRandomQuestions(parameters, questionsCollection);

        if (questions && questions.length > 0) {
            // --- THAY ĐỔI Ở ĐÂY ---
            // Tạo chuỗi hiển thị bao gồm cả nội dung và lựa chọn
            const formattedQuestions = questions.map((q, index) => {
                let questionBlock = `${index + 1}. ${q.content}`; // Bắt đầu với số thứ tự và nội dung

                // Kiểm tra xem có options không và định dạng chúng
                if (q.options && Array.isArray(q.options) && q.options.length > 0) {
                    // Giả sử options trong CSDL là một mảng các chuỗi như "A. Nội dung A", "B. Nội dung B",...
                    // Thêm các options vào, mỗi option một dòng và thụt vào cho dễ đọc
                    const optionsString = q.options.map(opt => `   ${opt}`).join('\n');
                    questionBlock += `\n${optionsString}`; // Thêm các lựa chọn vào sau nội dung câu hỏi
                }
                return questionBlock; // Trả về khối text hoàn chỉnh cho câu hỏi này
            }).join('\n\n'); // Thêm một dòng trống giữa các câu hỏi

            result.responseText = `Đây là ${questions.length} câu hỏi theo yêu cầu của bạn:\n\n${formattedQuestions}\n\nBạn muốn xem đáp án hoặc giải thích cho câu nào?`;
            // --- KẾT THÚC THAY ĐỔI ---

            // Lưu dữ liệu câu hỏi vào context (Đảm bảo có cả options)
            const sessionInfo = extractSessionInfo(sessionPath);
            const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'quiz_list_followup');
            

            const questionDataForContext = questions.map(q => ({
                 question_id:  q.question_id.toString(),
            }));

            // Cảnh báo/Kiểm tra kích thước context nếu cần
            // if (Buffer.byteLength(questionDataString, 'utf8') > YOUR_CONTEXT_LIMIT) ...

            result.outputContexts.push({
                name: contextName,
                lifespanCount: 5, // Chờ 5 lượt
                parameters: {
                    question_data: questionDataForContext
                }
            });
console.log(`Setting Output Context: ${contextName} with ${questions.length} questions (including options).`);

        } else {
            result.responseText = "Xin lỗi, tôi không tìm thấy câu hỏi nào phù hợp với yêu cầu của bạn.";
        }
    } catch (error) {
        console.error("Error handling RequestQuestionList:", error);
        result.responseText = "Đã có lỗi xảy ra khi lấy danh sách câu hỏi.";
    }
    return result;
}

// Hàm chung để xử lý hỏi đáp án/giải thích cho danh sách
async function handleListQuery(parameters, inputContexts, sessionPath, type = 'answer') { // type = 'answer' hoặc 'explanation'
   const result = { responseText: "Lỗi xử lý yêu cầu.", outputContexts: [] };

   // Lấy context và dữ liệu câu hỏi
   const context = inputContexts.find(ctx => ctx.name.endsWith('/contexts/context_question_list_active'));
//    if (!context || !context.parameters || !context.parameters.question_data) {
//        result.responseText = "Xin lỗi, tôi không tìm thấy danh sách câu hỏi nào bạn đang xem. Hãy thử yêu cầu danh sách mới.";
//        return result;
//    }

   let questionData;
   
   try {
       // Parse lại mảng từ chuỗi JSON
       questionData = parameters.question_data;

        if (!Array.isArray(questionData)) {
          return result.status(400).json({ error: 'question_data phải là mảng.' });
        }

        const ids = questionData.map(item => new ObjectId(item.question_id));

        const results = await db.collection(QUESTIONS_COLLECTION).find({ _id: { $in: ids } }).toArray();
        result.responseText = "Đây là danh sách câu trả lời:\nn" + 
         results.map(((q,index) => `${index + 1}. ${q.correct_answer}`)).join("\n") + "\n Bạn có muốn tôi check đáp án cho bạn hay muốn tôi giải thích câu nào thì cứ nói nhé !!!"
   } catch (e) {
        console.error("Error parsing question_data from context:", e);
        result.responseText = "Có lỗi xảy ra khi đọc dữ liệu câu hỏi từ context.";
        return result;
   }


   const requestedNumbers = parameters.question_numbers || []; // Mảng số thứ tự
   const scope = parameters.scope; // Ví dụ: "all"
   const responseLines = [];
   const totalQuestions = questionData.length;

   let indicesToProcess = [];

   if (scope && String(scope).toLowerCase() === 'all') {
       indicesToProcess = Array.from({ length: totalQuestions }, (_, i) => i); // Mảng [0, 1, ..., N-1]
   } else if (requestedNumbers && requestedNumbers.length > 0) {
       // Chuyển số thứ tự người dùng (1-based) thành index (0-based)
       indicesToProcess = requestedNumbers.map(num => parseInt(num, 10) - 1)
                                       .filter(index => !isNaN(index) && index >= 0 && index < totalQuestions);
       indicesToProcess = [...new Set(indicesToProcess)]; // Loại bỏ trùng lặp
   } else {
        // Nếu không chỉ định số câu hoặc 'tất cả', có thể hỏi lại hoặc không làm gì
        result.responseText = `Bạn muốn xem ${type === 'answer' ? 'đáp án' : 'giải thích'} cho câu số mấy trong danh sách (${totalQuestions} câu)?`;
         // Vẫn reset context để duy trì
         const sessionInfo = extractSessionInfo(sessionPath);
         const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_question_list_active');
         result.outputContexts.push({
              name: contextName,
              lifespanCount: 5,
              parameters: context.parameters // Giữ nguyên data cũ
         });
        return result;
   }

   if (indicesToProcess.length === 0) {
        result.responseText = "Số thứ tự câu hỏi không hợp lệ hoặc không được cung cấp.";
        // Vẫn reset context
         const sessionInfo = extractSessionInfo(sessionPath);
         const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_question_list_active');
         result.outputContexts.push({
              name: contextName,
              lifespanCount: 5,
              parameters: context.parameters
         });
        return result;
   }

   indicesToProcess.sort((a, b) => a - b); // Sắp xếp index

   if (type === 'answer') {
       responseLines.push("Đáp án:");
       indicesToProcess.forEach(index => {
           const question = questionData[index];
           responseLines.push(`Câu ${index + 1}: ${question.correct_answer || 'N/A'}`);
       });
   } else { // type === 'explanation'
       responseLines.push("Giải thích:");
       indicesToProcess.forEach(index => {
           const question = questionData[index];
           responseLines.push(`Câu ${index + 1}: ${question.explanation || 'Không có giải thích.'}`);
       });
   }

   result.responseText = responseLines.join('\n');

   // Reset context để duy trì danh sách
   const sessionInfo = extractSessionInfo(sessionPath);
   const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_question_list_active');
   result.outputContexts.push({
       name: contextName,
       lifespanCount: 5, // Reset lifespan
       parameters: context.parameters // Giữ nguyên question_data
   });

   return result;
}

async function handleAskAnswerForList(parameters, inputContexts, sessionPath) {
    return await handleListQuery(parameters, inputContexts, sessionPath, 'answer');
}

async function handleAskExplanationForList(parameters, inputContexts, sessionPath) {
    return await handleListQuery(parameters, inputContexts, sessionPath, 'explanation');
}

// --- Các hàm tiện ích mới hoặc được điều chỉnh cho handleCombinedRequest ---

// Hàm này giúp lấy câu hỏi và định dạng chúng, đồng thời chuẩn bị context.
// Nó được sử dụng khi 'quiz' và 'explain_quiz' diễn ra trong cùng một lượt.
async function formatAndStoreQuizQuestions(params, sessionPath, questionsCollection, extractSessionInfoFn, buildContextNameFn) {
    const detailedQuestions = await getRandomQuestions(params, questionsCollection); // getRandomQuestions phải được định nghĩa ở nơi khác
    let responseText = "";
    let contextParams = null;
    let questionsForExplanation = null; // Trả về dữ liệu câu hỏi đầy đủ

    if (detailedQuestions && detailedQuestions.length > 0) {
        questionsForExplanation = detailedQuestions;
        const conceptDisplayName = params.concept; // Nên lấy tên chuẩn từ DB nếu có
        const formattedQList = detailedQuestions.map((q, index) => {
            let qBlock = `${index + 1}. ${q.content}`;
            if (q.options && Array.isArray(q.options) && q.options.length > 0) {
                const opts = q.options.map(opt => `   ${opt}`).join('\n');
                qBlock += `\n${opts}`;
            }
            return qBlock;
        }).join('\n\n');
        responseText = `Đây là ${detailedQuestions.length} câu hỏi trắc nghiệm về ${conceptDisplayName}:\n\n${formattedQList}`;

        const sessionInfo = extractSessionInfoFn(sessionPath);
        const contextName = buildContextNameFn(sessionInfo.projectId, sessionInfo.sessionId, 'context_question_list_active');
        const questionDataForContext = detailedQuestions.map(q => ({
            question_id: q.question_id.toString(),
            // Các trường khác có thể thêm vào context nếu cần bởi các intent theo dõi
        }));
        contextParams = {
            name: contextName,
            lifespanCount: 5,
            parameters: { question_data: questionDataForContext, original_concept: params.concept }
        };
    } else {
        responseText = `Xin lỗi, tôi không tìm thấy câu hỏi trắc nghiệm nào về ${params.concept}.`;
    }
    return { responseText, contextParams, questionsForExplanation };
}

// Hàm này định dạng giải thích cho các câu hỏi trắc nghiệm.
function formatQuizExplanations(questions, conceptName) {
    if (!questions || questions.length === 0) return "";
    const explanations = questions.map((q, index) => {
        return `Câu ${index + 1} (${q.content ? q.content.substring(0, 30) : 'Hỏi'}...):\nĐáp án đúng: ${q.correct_answer}\nGiải thích: ${q.explanation || "Không có giải thích chi tiết."}`;
    }).join('\n\n');
    return `Giải thích cho các câu hỏi về ${conceptName}:\n\n${explanations}`;
}


async function handleCombinedRequest(parameters, sessionPath, inputContexts = []) { // Thêm inputContexts
    const result = { responseText: "Tôi đang xử lý yêu cầu của bạn...", outputContexts: [] };
    const actions = Array.isArray(parameters.action_verb) ? parameters.action_verb : (parameters.action_verb ? [parameters.action_verb] : []);
    const concepts = Array.isArray(parameters.concept) ? parameters.concept : (parameters.concept ? [parameters.concept] : []);

    let mainConceptParam = concepts.length > 0 ? concepts[0] : null;

    if (actions.length === 0) {
        result.responseText = "Xin lỗi, tôi chưa hiểu rõ bạn muốn tôi làm gì.";
        return result;
    }
    if (!mainConceptParam && actions.some(act => ['explain', 'example', 'quiz'].includes(act))) {
        result.responseText = "Xin lỗi, bạn muốn thực hiện hành động này về khái niệm nào?";
        return result;
    }
    if (!mainConceptParam && actions.includes('compare') && concepts.length < 2) {
        result.responseText = "Xin lỗi, để so sánh tôi cần ít nhất một khái niệm chính hoặc hai khái niệm được cung cấp.";
        return result;
    }


    console.log(`Handling combined request - Concepts: [${concepts.join(', ')}], Actions: [${actions.join(', ')}]`);

    let combinedResponseParts = [];
    // db, CONCEPTS_COLLECTION, QUESTIONS_COLLECTION phải truy cập được từ scope này
    // Ví dụ: const db = getDB(); const conceptsCollection = db.collection(CONCEPTS_COLLECTION);

    let mainConceptDoc = null;
    let mainConceptDisplayName = mainConceptParam;
    if (mainConceptParam) {
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
        mainConceptDoc = await findConcept(mainConceptParam, conceptsCollection);
        if (mainConceptDoc) {
            mainConceptDisplayName = mainConceptDoc.name || mainConceptParam;
        } else {
            console.warn(`Combined Request: Main concept "${mainConceptParam}" not found.`);
        }
    }

    let locallyGeneratedQuestions = null;

    try {
        for (const action of actions) {
            if (!mainConceptDoc && ['explain', 'example', 'quiz'].includes(action)) {
                combinedResponseParts.push(`Tôi không tìm thấy thông tin về khái niệm "${mainConceptParam}" để có thể "${action}".`);
                continue;
            }

            switch (action) {
                case 'explain':
                    const explainParams = { concept: mainConceptParam };
                    const definitionResult = await handleAskDefinition(explainParams, sessionPath, true); // true for detailed
                    if (definitionResult.responseText) combinedResponseParts.push(definitionResult.responseText);
                    if (definitionResult.outputContexts) result.outputContexts.push(...definitionResult.outputContexts);
                    break;

                case 'example':
                    // Ví dụ: "so sánh A và B, sau đó cho ví dụ về A". `mainConceptParam` (A) được dùng.
                    const exampleParams = { concept: mainConceptParam };
                    const exampleResult = await handleAskExample(exampleParams); // handleAskExample không dùng sessionPath trong signature
                    if (exampleResult.responseText) combinedResponseParts.push(exampleResult.responseText);
                    if (exampleResult.outputContexts) result.outputContexts.push(...exampleResult.outputContexts);
                    break;

                case 'compare':
                    let concept1ForCompare = concepts[0];
                    let concept2ForCompare = concepts.length > 1 ? concepts[1] : null;

                    if (!concept1ForCompare || !concept2ForCompare) {
                        combinedResponseParts.push(`Để so sánh, tôi cần hai khái niệm. Bạn mới chỉ cung cấp "${concept1ForCompare || concept2ForCompare || 'một vài'}" khái niệm.`);
                    } else {
                        const compareP = { concept: [concept1ForCompare, concept2ForCompare] };
                        const comparisonResult = await handleAskComparison(compareP);
                        if (comparisonResult.responseText) combinedResponseParts.push(comparisonResult.responseText);
                        if (comparisonResult.outputContexts) result.outputContexts.push(...comparisonResult.outputContexts);
                    }
                    break;

                case 'quiz':
                    const quizP = {
                        concept: mainConceptParam,
                        number: parameters.number || 3, // Default 3, or allow Dialogflow to pass 'number'
                    };
                    const questionsCollection = db.collection(QUESTIONS_COLLECTION);
                    const currentActionIndex = actions.indexOf(action);
                    const nextActionIsExplainQuiz = (currentActionIndex + 1 < actions.length) && (actions[currentActionIndex + 1] === 'explain_quiz');

                    if (nextActionIsExplainQuiz) {
                        // Lấy câu hỏi và lưu trữ để giải thích ngay sau đó
                        const quizData = await formatAndStoreQuizQuestions(quizP, sessionPath, questionsCollection, extractSessionInfo, buildContextName);
                        if (quizData.responseText) combinedResponseParts.push(quizData.responseText);
                        if (quizData.contextParams) result.outputContexts.push(quizData.contextParams);
                        locallyGeneratedQuestions = quizData.questionsForExplanation;
                    } else {
                        // Gọi handleRequestQuestionList chuẩn
                        const quizListResult = await handleRequestQuestionList(quizP, sessionPath);
                        if (quizListResult.responseText) combinedResponseParts.push(quizListResult.responseText);
                        if (quizListResult.outputContexts) result.outputContexts.push(...quizListResult.outputContexts);
                    }
                    break;

                case 'explain_quiz':
                    if (locallyGeneratedQuestions && locallyGeneratedQuestions.length > 0) {
                        const explanationText = formatQuizExplanations(locallyGeneratedQuestions, mainConceptDisplayName);
                        combinedResponseParts.push(explanationText);
                    } else {
                        // Thử giải thích dựa trên context đang hoạt động nếu có
                        const activeQuizContext = (result.outputContexts.find(ctx => ctx.name && ctx.name.endsWith('/contexts/context_question_list_active'))) ||
                                               (inputContexts.find(ctx => ctx.name && ctx.name.endsWith('/contexts/context_question_list_active')));
                        if (activeQuizContext && activeQuizContext.parameters && activeQuizContext.parameters.question_data) {
                             const explainListParams = {
                                // handleAskExplanationForList mong muốn question_data và scope/question_numbers trong parameters
                                // Truyền trực tiếp parameters của context cho handleAskExplanationForList
                                ...activeQuizContext.parameters, 
                                scope: "all", // Giả sử giải thích tất cả trong trường hợp này
                             };
                             const effectiveInputContexts = result.outputContexts.length > 0 ? result.outputContexts : inputContexts;
                             const explanationListResult = await handleAskExplanationForList(explainListParams, effectiveInputContexts, sessionPath);
                             if (explanationListResult.responseText) combinedResponseParts.push(explanationListResult.responseText);
                             if (explanationListResult.outputContexts && explanationListResult.outputContexts.length > 0) {
                                const existingCtxIdx = result.outputContexts.findIndex(c => c.name === explanationListResult.outputContexts[0].name);
                                if (existingCtxIdx !== -1) {
                                    result.outputContexts[existingCtxIdx] = explanationListResult.outputContexts[0];
                                } else {
                                    result.outputContexts.push(...explanationListResult.outputContexts);
                                }
                            }
                        } else {
                            combinedResponseParts.push("Tôi có thể giải thích đáp án nếu bạn vừa yêu cầu tôi tạo câu hỏi, hoặc nếu có một danh sách câu hỏi đang hoạt động.");
                        }
                    }
                    break;
                default:
                    console.warn(`Unknown action in combined request: ${action}`);
            }
        }

        if (combinedResponseParts.length > 0) {
            result.responseText = combinedResponseParts.join("\n\n---\n\n").trim();
        } else {
            result.responseText = `Tôi đã nhận được yêu cầu ${actions.length > 0 ? "với hành động '" + actions.join(', ') + "'" : ""} ${mainConceptParam ? "về '" + mainConceptDisplayName + "'" : ""} nhưng không thể tạo phản hồi cụ thể.`;
        }

        // Hợp nhất và dọn dẹp outputContexts
        if (result.outputContexts.length > 0) {
            const uniqueContextsMap = new Map();
            for (let i = result.outputContexts.length - 1; i >= 0; i--) { // Ưu tiên context thêm sau (mới hơn)
                const context = result.outputContexts[i];
                if (context && context.name) {
                    if (!uniqueContextsMap.has(context.name)) {
                        uniqueContextsMap.set(context.name, { ...context }); // Clone context
                    } else {
                        const existingContext = uniqueContextsMap.get(context.name);
                        existingContext.parameters = { ...existingContext.parameters, ...context.parameters }; // Merge params, mới hơn ghi đè
                        existingContext.lifespanCount = Math.max(existingContext.lifespanCount || 0, context.lifespanCount || 0);
                    }
                }
            }
            result.outputContexts = Array.from(uniqueContextsMap.values());
        }

        // Đặt context theo dõi chung nếu không có context cụ thể nào được đặt
        const isActiveQuizContext = result.outputContexts.some(c => c.name && c.name.endsWith('context_question_list_active'));
        const hasConceptFollowupContext = result.outputContexts.some(c => c.name && c.name.endsWith('concept_followup'));

        if (mainConceptDoc && combinedResponseParts.length > 0 && !isActiveQuizContext && !hasConceptFollowupContext) {
            const sessionInfo = extractSessionInfo(sessionPath);
            const contextId = 'concept_followup';
            const contextFullName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, contextId);
            result.outputContexts.push({
                name: contextFullName,
                lifespanCount: 3,
                parameters: {
                    concept: mainConceptDoc.concept_id || mainConceptParam
                }
            });
            console.log(`Combined Request: Setting general Output Context ${contextFullName} for concept: ${mainConceptDoc.concept_id || mainConceptParam}`);
        }

    } catch (error) {
        console.error("Error in handleCombinedRequest:", error);
        result.responseText = "Đã có lỗi xảy ra khi xử lý yêu cầu kết hợp của bạn.";
    }
    return result;
}

function extractKeywords(text) {
    if (!text) return [];
    const lowerText = text.toLowerCase();
    // Bổ sung thêm từ dừng nếu cần
    const stopWords = [
        'là', 'gì', 'thế', 'nào', 'vậy', 'bạn', 'mình', 'cho', 'biết', 'về', 'của', 'và', 'hoặc',
        'thì', 'mà', 'như', 'tại', 'sao', 'hãy', 'đi', 'có', 'không', 'được', 'một', 'các', 'những',
        'the', 'a', 'an', 'is', 'what', 'how', 'why', 'tell', 'me', 'about', 'of', 'and', 'or',
        'can', 'you', 'please', 'explain', 'define', 'show', 'example', 'comparison',
        '?', '.', ',', '!',':'
    ];
    const words = lowerText.split(/\s+/);
    const keywords = words.filter(word => {
        const cleanWord = word.replace(/[?.,!:]/g, '');
        return cleanWord && !stopWords.includes(cleanWord) && cleanWord.length > 1; // Lấy từ dài hơn 1 ký tự
    });
    // Cân nhắc thêm xử lý từ ghép tiếng Việt nếu cần độ chính xác cao hơn
    return [...new Set(keywords)];
}

// Hàm cố gắng phân tích câu hỏi trắc nghiệm người dùng gửi
function parseUserMultipleChoiceQuestion(fullText) {
    const questionParts = {
        questionContent: null,
        options: [], // Mảng các chuỗi option text (không bao gồm A, B, C, D)
        optionsRaw: [], // Mảng các chuỗi option đầy đủ (VD: "A. Option A")
        isMultipleChoice: false
    };
    const optionRegex = /\b([A-Da-d])[\.\)\-\s]\s*([^?A-Da-d\n]+)/g;
    let match;
    let questionEndIndex = -1; // Index kết thúc của phần nội dung câu hỏi

    while ((match = optionRegex.exec(fullText)) !== null) {
        questionParts.isMultipleChoice = true;
        const optionLetter = match[1].toUpperCase();
        const optionText = match[2].trim();
        questionParts.options.push(optionText); // Chỉ lấy nội dung lựa chọn
        questionParts.optionsRaw.push(`${optionLetter}. ${optionText}`); // Lấy cả chữ cái
        if (questionEndIndex === -1) {
            questionEndIndex = match.index; // Đánh dấu vị trí bắt đầu của lựa chọn đầu tiên
        }
    }

    if (questionParts.isMultipleChoice && questionEndIndex !== -1) {
        questionParts.questionContent = fullText.substring(0, questionEndIndex).replace(/câu hỏi:|trắc nghiệm:|hỏi:/gi, '').trim();
    } else {
        // Nếu không parse được options, coi như là câu hỏi lý thuyết
        questionParts.questionContent = fullText;
        questionParts.isMultipleChoice = false;
    }
     // Xóa dấu ? ở cuối câu hỏi nếu có
    if (questionParts.questionContent && questionParts.questionContent.endsWith('?')) {
        questionParts.questionContent = questionParts.questionContent.slice(0, -1).trim();
    }

    return questionParts;
}

// --- Hàm xử lý cho Action: answer_theory_question ---
// (Xử lý câu hỏi lý thuyết/mở do người dùng đặt)
async function handleAskTheoryQuestion(parameters) {
    const result = { responseText: "Xin lỗi, tôi chưa thể trả lời câu hỏi này.", outputContexts: [] };
    // Giả sử parameter chứa câu hỏi là 'user_question' hoặc tên tương tự bạn đặt trong Intent
    const userQuestion = parameters.user_question || parameters.user_full_question; // Lấy Paremater chứa câu hỏi

    if (!userQuestion) {
        result.responseText = "Bạn muốn hỏi tôi điều gì cụ thể?";
        return result;
    }

    console.log(`Handling User Theory Question: ${userQuestion}`);
    const keywords = extractKeywords(userQuestion);
    console.log("Extracted keywords:", keywords);

    if (keywords.length === 0) {
        result.responseText = "Câu hỏi của bạn có vẻ hơi chung chung. Bạn có thể nói rõ hơn được không?";
        return result;
    }

    try {
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        let foundAnswer = null;

        // 1. Tìm trong Concepts (ưu tiên)
        for (const keyword of keywords) {
            const conceptDoc = await conceptsCollection.findOne({
                $or: [
                    { concept_id: { $regex: new RegExp(`^${keyword}$`, "i") } },
                    { name: { $regex: new RegExp(keyword, "i") } },
                    { aliases: { $regex: new RegExp(`^${keyword}$`, "i") } }
                ]
            });
            if (conceptDoc) {
                // Tìm thấy concept -> Ưu tiên trả về definition hoặc explanation
                foundAnswer = `Về ${conceptDoc.name || keyword}: ${conceptDoc.definition || ''}\n\n${conceptDoc.explanation_detailed || ''}`;
                // Có thể thêm logic kiểm tra từ khóa "ví dụ", "so sánh" ở đây nếu muốn
                break; // Dừng lại khi tìm thấy concept khớp mạnh
            }
        }

        // 2. Nếu không tìm thấy trong Concepts, tìm trong Questions (loại theory)
        if (!foundAnswer) {
            // Xây dựng query tìm kiếm text (nếu đã tạo text index) hoặc regex
            // Ví dụ dùng regex:
            const regexKeywords = keywords.map(k => new RegExp(k, "i"));
            const dbTheoryQuestion = await questionsCollection.findOne({
                type: "theory",
                content: { $in: regexKeywords } // Tìm câu hỏi chứa bất kỳ từ khóa nào
                // Hoặc dùng $text search: $text: { $search: keywords.join(" ") }
            });

            if (dbTheoryQuestion) {
                foundAnswer = `Liên quan đến câu hỏi của bạn, tôi có thông tin sau trong CSDL câu hỏi lý thuyết:\n**Hỏi:** "${dbTheoryQuestion.content}"\n**Đáp:** ${dbTheoryQuestion.correct_answer}\n${dbTheoryQuestion.explanation || ""}`;
            }
        }

        // 3. Trả lời
        if (foundAnswer) {
            result.responseText = foundAnswer;
        } else {
            result.responseText = `Xin lỗi, tôi chưa có đủ thông tin để trả lời câu hỏi: "${userQuestion}".`;
        }

    } catch (error) {
        console.error("Error handling User Theory Question:", error);
        result.responseText = "Đã có lỗi xảy ra khi tôi cố gắng tìm câu trả lời cho bạn.";
    }
    return result;
}

// --- Hàm xử lý cho Action: answer_quiz_question ---
// (Xử lý câu hỏi TRẮC NGHIỆM do người dùng đặt - Chỉ tìm câu hỏi giống trong DB)
async function handleAskQuizQuestionByUser(parameters) {
    const result = { responseText: "Xin lỗi, tôi chưa thể trả lời câu hỏi trắc nghiệm này.", outputContexts: [] };
    // Giả sử parameter chứa toàn bộ câu hỏi + lựa chọn là 'user_mc_question'
    const userMCQuestionFull = parameters.user_mc_question || parameters.user_full_question;

    if (!userMCQuestionFull) {
        result.responseText = "Bạn vui lòng cung cấp câu hỏi trắc nghiệm và các lựa chọn.";
        return result;
    }

    console.log(`Handling User MCQ: ${userMCQuestionFull}`);
    const parsedMCQ = parseUserMultipleChoiceQuestion(userMCQuestionFull);

    // Chỉ xử lý nếu parse thành công ra câu hỏi và lựa chọn
    if (!parsedMCQ.isMultipleChoice || !parsedMCQ.questionContent || parsedMCQ.options.length === 0) {
        console.log("Could not parse as MCQ, treating as theory question instead.");
        // Chuyển sang xử lý như câu hỏi lý thuyết
        // Tạo parameters giả lập cho handleAskTheoryQuestion
        const theoryParams = { user_question: userMCQuestionFull };
        return await handleAskTheoryQuestion(theoryParams);
    }

    console.log("Parsed MCQ Content:", parsedMCQ.questionContent);
    console.log("Parsed MCQ Options:", parsedMCQ.optionsRaw);

    try {
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);

        // Tìm câu hỏi trắc nghiệm rất giống trong CSDL
        // Sử dụng $text search nếu bạn đã tạo index text trên trường 'content'
        // Hoặc dùng regex như ví dụ dưới (ít hiệu quả hơn với câu dài)
        const queryContent = parsedMCQ.questionContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape regex chars
        const potentialMatches = await questionsCollection.find({
            type: "multiple_choice",
            // $text: { $search: `"${queryContent}"` } // Dùng text search nếu có
             content: { $regex: new RegExp(queryContent, "i") } // Dùng regex (kém chính xác hơn)
        }).limit(5).toArray(); // Giới hạn số lượng kiểm tra

        let bestMatch = null;
        let highestScore = 0.75; // Ngưỡng tương đồng tối thiểu (ví dụ)

        // Logic so sánh đơn giản - có thể cần cải thiện
        for (const dbMCQ of potentialMatches) {
            let currentScore = 0;
            // Đo độ tương đồng nội dung câu hỏi (ví dụ: dùng hàm tính độ tương đồng chuỗi)
            // const contentSimilarity = calculateStringSimilarity(parsedMCQ.questionContent, dbMCQ.content);
            // if (contentSimilarity < 0.8) continue; // Bỏ qua nếu nội dung quá khác

            // So sánh options
            if (dbMCQ.options && dbMCQ.options.length === parsedMCQ.optionsRaw.length) {
                let optionMatches = 0;
                parsedMCQ.optionsRaw.forEach(userOptRaw => {
                     // Kiểm tra xem option của user có trong options của DB không (so sánh phần text)
                    const userOptLetter = userOptRaw.substring(0, 1).toUpperCase();
                    const userOptText = userOptRaw.substring(3).trim().toLowerCase();
                    if (dbMCQ.options.some(dbOptRaw => {
                        const dbOptLetter = dbOptRaw.substring(0, 1).toUpperCase();
                        const dbOptText = dbOptRaw.substring(3).trim().toLowerCase();
                        return dbOptLetter === userOptLetter && dbOptText.includes(userOptText); // So sánh đơn giản
                    })) {
                        optionMatches++;
                    }
                });
                 currentScore = optionMatches / dbMCQ.options.length;
            }

            if (currentScore >= highestScore) {
                 highestScore = currentScore;
                 bestMatch = dbMCQ;
            }
        }


        if (bestMatch) {
             console.log(`Found similar MCQ in DB (ID: ${bestMatch._id}) with score: ${highestScore}`);
             result.responseText = `Tôi tìm thấy câu hỏi tương tự trong cơ sở dữ liệu:\n"${bestMatch.content}"\nĐáp án đúng là: **${bestMatch.correct_answer}**\n*Giải thích:* ${bestMatch.explanation || "Không có giải thích chi tiết."}`;
        } else {
            console.log("No similar MCQ found in DB.");
            result.responseText = `Xin lỗi, tôi không tìm thấy câu hỏi trắc nghiệm nào giống với câu hỏi của bạn trong cơ sở dữ liệu của mình để có thể đưa ra đáp án chính xác.`;
             // Có thể gợi ý hỏi về concept liên quan
             const keywords = extractKeywords(parsedMCQ.questionContent);
             if(keywords.length > 0) {
                 const conceptDoc = await findConcept(keywords[0], db.collection(CONCEPTS_COLLECTION));
                 if(conceptDoc) {
                     result.responseText += `\nTuy nhiên, bạn có muốn tìm hiểu về khái niệm "${conceptDoc.name}" không?`;
                 }
             }
        }

    } catch (error) {
        console.error("Error handling User MCQ:", error);
        result.responseText = "Đã có lỗi xảy ra khi tôi cố gắng tìm câu trả lời cho câu hỏi trắc nghiệm của bạn.";
    }
    return result;
}


// --- Endpoint Webhook Chính ---
app.post('/webhook', async (req, res) => {
    // ... (Phần này giữ nguyên logic switch case, nhưng case sẽ gọi các hàm handler đã được chỉnh sửa ở trên) ...

     if (!db) { await connectDB(); }
     if (!db) { return res.status(500).json({ fulfillmentText: "Lỗi nghiêm trọng: Không thể kết nối cơ sở dữ liệu." }); }

     const queryResult = req.body.queryResult;
     const actionName = req.body.queryResult.action;
     const intentName = queryResult.intent.displayName;
     const parameters = queryResult.parameters;
     const sessionPath = req.body.session;
     const inputContexts = req.body.queryResult.outputContexts || [];

     console.log(`[${new Date().toISOString()}] Action: "${actionName}", Intent: "${intentName}", Session: ${sessionPath}`);

     let handlerResult = { responseText: "Xin lỗi, tôi chưa hiểu rõ yêu cầu của bạn.", outputContexts: [] };

     try {
          switch (actionName) {
            case 'give_definition':
                handlerResult = await handleAskDefinition(parameters, sessionPath, false);
                  break;
              case 'give_definition_detailed':
                handlerResult = await handleAskDefinition(parameters, sessionPath, true);
                  break;
            case 'compare_topics':
                handlerResult = await handleAskComparison(parameters);
                break;
            case 'give_example': // Bạn có thể gộp nếu logic xử lý ví dụ là chung
                handlerResult = await handleAskExample(parameters); // Hàm này cần xử lý cả context
                break;
            case 'handle_combined_request':
                handlerResult = await handleCombinedRequest(parameters, sessionPath);
                break;
            case 'generate_quiz_list':
                handlerResult = await handleRequestQuestionList(parameters, sessionPath);
                break;
            case 'quiz_answer':
                handlerResult = await handleAskAnswerForList(parameters, inputContexts, sessionPath);
                break;
            case 'explain_quiz':
                handlerResult = await handleAskExplanationForList(parameters, inputContexts, sessionPath);
                  break;
              case 'answer_quiz_question':
                handlerResult = await handleAskQuizQuestion(parameters, inputContexts, sessionPath);
                  break;
              case 'answer_theory_question':
                handlerResult = await handleAskTheoryQuestion(parameters, inputContexts, sessionPath);
                  break;
              case 'submit_quiz_answer':
                  handlerResult = await handleSubmitQuizQuestion(parameters, inputContexts, sessionPath);
            // Các action cho intent phụ trợ nếu webhook cần xử lý
            // case 'action.welcome':
            //     handlerResult.responseText = "Chào mừng bạn đến với trợ lý ảo bảo mật!";
            //     break;
            // case 'action.cancelCurrent':
            //     // Logic hủy
            //     break;
            default:
                console.log(`Action "${actionName}" (Intent: "${intentName}") chưa được xử lý. Sẽ dùng Default Fallback của Dialogflow.`);
                // Nếu bạn muốn webhook trả lời mặc định khi không có action nào khớp trong webhook (nhưng intent đó lại bật webhook)
                // handlerResult.responseText = `Action "${actionName}" chưa được hỗ trợ qua webhook.`;
                // Thường thì nếu intent không có logic webhook, bạn sẽ không bật webhook cho nó trong Dialogflow
                // và để Dialogflow tự trả lời bằng "Responses" đã cấu hình.
                // Nếu một action được gửi đến đây mà không có case, nghĩa là bạn đã bật webhook cho intent đó nhưng chưa code logic.
                if (actionName) {
                    handlerResult.responseText = `Action "${actionName}" đang được phát triển.`;
                }
                break;
        }
     } catch (error) {
          console.error(`Error handling intent ${intentName}:`, error);
          handlerResult.responseText = "Rất tiếc, đã có lỗi xảy ra trong quá trình xử lý yêu cầu của bạn.";
          handlerResult.outputContexts = [];
     }

     // --- Gửi phản hồi về Dialogflow ---
     const responseJson = {
          fulfillmentMessages: [{ text: { text: [handlerResult.responseText || "Tôi không có phản hồi cho việc này."] } }],
          outputContexts: handlerResult.outputContexts || []
     };

     console.log("--- Sending Response to Dialogflow (Context-Only Quiz State) ---");
     console.log(JSON.stringify(responseJson, null, 2));
     console.log("-------------------------------------------------------------");

     res.json(responseJson);
});


app.get('/', (req, res) => {
  res.status(200).json({ status: 'Webhook server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Local server listening on port 3000');

});