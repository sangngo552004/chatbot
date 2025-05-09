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
    const match = typeof sessionPath === 'string' 
        ? sessionPath.match(/projects\/([^/]+)\/(?:agent\/)?(?:environments\/[^/]+\/users\/[^/]+\/)?sessions\/([^/]+)/) 
        : null;
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
async function handleGiveDefinition(parameters, sessionPath, explainationDetailed = false) {
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


async function handleComparison(parameters) {
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

async function handleGiveExample(parameters) {
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
    if (!db) db = getDB();

    try {
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        // queryParams are passed to getRandomQuestions
        const queryParams = {
            ...parameters, // Includes concept (array), number, question_type (array), topic
            // getRandomQuestions might expect 'concept' as a single string
            concept: Array.isArray(parameters.concept) ? parameters.concept[0] : parameters.concept
        };

        const questions = await getRandomQuestions(queryParams, questionsCollection);

        if (questions && questions.length > 0) {
            const formattedQuestions = questions.map((q, index) => {
                let questionBlock = `${index + 1}. ${q.content}`;
                if (q.options && Array.isArray(q.options) && q.options.length > 0) {
                    const optionsString = q.options.map(opt => `    ${opt}`).join('\n');
                    questionBlock += `\n${optionsString}`;
                }
                return questionBlock;
            }).join('\n\n');

            result.responseText = `Đây là ${questions.length} câu hỏi theo yêu cầu của bạn:\n\n${formattedQuestions}\n\nBạn muốn xem đáp án hoặc giải thích cho câu nào không?`;

            const sessionInfo = extractSessionInfo(sessionPath);
            const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'quiz_list_followup');
            
            const questionDataForContext = questions.map(q => ({
                question_id: q.question_id // Already a string from getRandomQuestions
            }));

            result.outputContexts.push({
                name: contextName,
                lifespanCount: 5,
                parameters: { // Store all relevant original parameters along with the new question_data
                    concept: parameters.concept, // Keep original array format from Dialogflow
                    number: parameters.number,
                    question_type: parameters.question_type, // Keep original array format
                    topic: parameters.topic,
                    question_data: questionDataForContext // This is the list of question IDs
                }
            });
            console.log(`Setting Output Context: ${contextName} with ${questions.length} questions. question_data:`, JSON.stringify(questionDataForContext));

        } else {
            const conceptName = Array.isArray(parameters.concept) ? parameters.concept[0] : parameters.concept;
            result.responseText = `Xin lỗi, tôi không tìm thấy câu hỏi trắc nghiệm nào về chủ đề "${conceptName || 'bạn yêu cầu'}".`;
        }
    } catch (error) {
        console.error("Error handling RequestQuestionList:", error);
        result.responseText = "Đã có lỗi nghiêm trọng xảy ra khi tôi cố gắng tạo danh sách câu hỏi cho bạn.";
    }
    return result;
}

async function handleListQuery(parameters, sessionPath, type = 'answer') {
    const result = { responseText: "Lỗi không xác định khi xử lý yêu cầu của bạn.", outputContexts: [] };
    if (!db) db = getDB();

    const questionDataFromParams = parameters.question_data;

    if (!questionDataFromParams || !Array.isArray(questionDataFromParams) || questionDataFromParams.length === 0) {
        result.responseText = "Xin lỗi, dường như không có danh sách câu hỏi nào đang hoạt động. Bạn có muốn tôi tạo một danh sách mới không?";
        const sessionInfoClear = extractSessionInfo(sessionPath);
        const contextFullNameClear = buildContextName(sessionInfoClear.projectId, sessionInfoClear.sessionId, 'quiz_list_followup');
        result.outputContexts.push({ name: contextFullNameClear, lifespanCount: 0 });
        return result;
    }

    const requestedNumbers = parameters['question-numbers'] || parameters.question_numbers || [];
    const scope = parameters.scope;
    
    const responseLines = [];
    const allQuestionIdsInCurrentList = questionDataFromParams.map(item => item.question_id);
    const totalQuestionsInList = allQuestionIdsInCurrentList.length;

    let questionIdsToFetchDetailsFor = [];
    let userRequestedSpecificQuestions = false;
    let processingAllDueToNoSpecification = false;

    if (scope && String(scope).toLowerCase() === 'all') {
        questionIdsToFetchDetailsFor = allQuestionIdsInCurrentList;
        console.log("Processing all questions due to 'scope=all'.");
    } else if (requestedNumbers && requestedNumbers.length > 0) {
        userRequestedSpecificQuestions = true;
        const validIndices = requestedNumbers
            .map(num => parseInt(num, 10) - 1)
            .filter(index => !isNaN(index) && index >= 0 && index < totalQuestionsInList);
        
        if (validIndices.length === 0 && requestedNumbers.length > 0) { // User provided numbers, but all were invalid
            result.responseText = `Số thứ tự câu hỏi bạn cung cấp không hợp lệ. Danh sách này có ${totalQuestionsInList} câu (từ 1 đến ${totalQuestionsInList}).`;
        } else {
            questionIdsToFetchDetailsFor = [...new Set(validIndices.map(index => allQuestionIdsInCurrentList[index]))];
        }
        console.log(`Processing specific questions by numbers. IDs to fetch: ${JSON.stringify(questionIdsToFetchDetailsFor)}`);
    } else {
        // NEW BEHAVIOR: If no specific numbers and no "all" scope, default to all.
        console.log("No specific numbers or 'all' scope provided. Defaulting to all questions.");
        questionIdsToFetchDetailsFor = allQuestionIdsInCurrentList;
        processingAllDueToNoSpecification = true; // Flag to potentially add a note in the response
    }
    
    if (questionIdsToFetchDetailsFor.length > 0) {
        try {
            const objectIdsToQuery = questionIdsToFetchDetailsFor.map(id => new ObjectId(id));
            const questionsFromDB = await db.collection(QUESTIONS_COLLECTION)
                                        .find({ _id: { $in: objectIdsToQuery } })
                                        .toArray();

            const dbQuestionsMap = new Map(questionsFromDB.map(q => [q._id.toString(), q]));
            
            let itemsProcessedCounter = 0;
            const iterationOrder = userRequestedSpecificQuestions ? questionIdsToFetchDetailsFor : allQuestionIdsInCurrentList.filter(id => questionIdsToFetchDetailsFor.includes(id));

            iterationOrder.forEach(qId => {
                const questionDetail = dbQuestionsMap.get(qId);
                if (questionDetail) {
                    itemsProcessedCounter++;
                    const originalIndex = allQuestionIdsInCurrentList.indexOf(qId);
                    const questionNumberLabel = originalIndex + 1; 

                    if (type === 'answer') {
                        if (responseLines.length === 0) {
                            let header = "Đây là đáp án:";
                            if (processingAllDueToNoSpecification && totalQuestionsInList > 1) { // Add note if showing all by default for multiple questions
                                header = `Bạn không chỉ định câu cụ thể nên tôi hiển thị đáp án cho tất cả ${totalQuestionsInList} câu:`;
                            } else if (userRequestedSpecificQuestions) {
                                header = "Đáp án cho các câu bạn chọn:";
                            }
                            responseLines.push(header);
                        }
                        responseLines.push(`Câu ${questionNumberLabel}: ${questionDetail.correct_answer || 'N/A (Không có đáp án)'}`);
                    } else { // type === 'explanation'
                         if (responseLines.length === 0) {
                            let header = "Đây là giải thích:";
                             if (processingAllDueToNoSpecification && totalQuestionsInList > 1) {
                                header = `Bạn không chỉ định câu cụ thể nên tôi hiển thị giải thích cho tất cả ${totalQuestionsInList} câu:`;
                            } else if (userRequestedSpecificQuestions) {
                                header = "Giải thích cho các câu bạn chọn:";
                            }
                            responseLines.push(header);
                        }
                        responseLines.push(`Câu ${questionNumberLabel} (${questionDetail.content ? questionDetail.content.substring(0,40)+'...' : 'Nội dung câu hỏi'}):\n  Đáp án: ${questionDetail.correct_answer || 'N/A'}\n  Giải thích: ${questionDetail.explanation || 'Không có giải thích chi tiết.'}`);
                    }
                } else {
                    const originalIndex = allQuestionIdsInCurrentList.indexOf(qId);
                    responseLines.push(`Câu ${originalIndex + 1}: Không tìm thấy chi tiết cho câu hỏi ID ${qId} trong cơ sở dữ liệu.`);
                }
            });

            if (itemsProcessedCounter > 0) {
                result.responseText = responseLines.join('\n\n');
                 if (type === 'answer') {
                    result.responseText += "\n\nBạn có muốn xem giải thích cho những câu này hoặc các câu khác không?";
                } else {
                    result.responseText += "\n\nBạn có câu hỏi nào khác không?";
                }
            } else if (result.responseText === "Lỗi không xác định khi xử lý yêu cầu của bạn." && requestedNumbers.length > 0) { 
                // This means numbers were given, but none were valid AND no items were processed.
                // The earlier check for `validIndices.length === 0` should have set a more specific message.
                // This is a fallback.
                 result.responseText = `Không có câu hỏi hợp lệ nào được tìm thấy từ các số bạn cung cấp.`;
            } else if (result.responseText === "Lỗi không xác định khi xử lý yêu cầu của bạn."){
                 result.responseText = `Tôi không tìm thấy thông tin ${type === 'answer' ? 'đáp án' : 'giải thích'} cho các câu hỏi được yêu cầu.`;
            }
        } catch (e) {
            console.error(`Error fetching details for ${type}:`, e);
            result.responseText = `Đã có lỗi xảy ra khi tôi cố gắng tìm ${type === 'answer' ? 'đáp án' : 'giải thích'} cho bạn.`;
        }
    } else if (result.responseText === "Lỗi không xác định khi xử lý yêu cầu của bạn.") {
        // This path is taken if `questionIdsToFetchDetailsFor` is empty AND no other responseText has been set yet.
        // This typically happens if `requestedNumbers` were provided but all were invalid, and the specific message for that was set.
        // If somehow it's still the default error, set a generic one.
        result.responseText = "Không có câu hỏi nào được chọn để xử lý.";
    }


    const sessionInfo = extractSessionInfo(sessionPath);
    const contextFullName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'quiz_list_followup');

    const contextParametersToMaintain = {
        concept: parameters.concept,
        number: parameters.number,
        question_type: parameters.question_type,
        topic: parameters.topic,
        question_data: questionDataFromParams,
    };

    result.outputContexts.push({
        name: contextFullName,
        lifespanCount: 5,
        parameters: contextParametersToMaintain
    });
    console.log("Re-setting context:", contextFullName, "with params:", JSON.stringify(contextParametersToMaintain));

    return result;
}

async function handleAskAnswerForList(parameters, inputContexts, sessionPath) {
    // inputContexts is available if needed for more complex logic, but handleListQuery
    // primarily relies on `parameters` for context data.
    return await handleListQuery(parameters, sessionPath, 'answer');
}

async function handleAskExplanationForList(parameters, inputContexts, sessionPath) {
    return await handleListQuery(parameters, sessionPath, 'explanation');
}


// --- Webhook Endpoint (Illustrative) ---
// Ensure connectDB() is called once when your app starts
// Example:
// 

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
                    const definitionResult = await handleGiveDefinition(explainParams, sessionPath, true); // true for detailed
                    if (definitionResult.responseText) combinedResponseParts.push(definitionResult.responseText);
                    if (definitionResult.outputContexts) result.outputContexts.push(...definitionResult.outputContexts);
                    break;

                case 'example':
                    // Ví dụ: "so sánh A và B, sau đó cho ví dụ về A". `mainConceptParam` (A) được dùng.
                    const exampleParams = { concept: mainConceptParam };
                    const exampleResult = await handleGiveExample(exampleParams); 
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
                        const comparisonResult = await handleComparison(compareP);
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
async function handleAskTheoryQuestion(parameters, sessionPath) { // sessionPath có thể không cần nếu không đặt context ở đây
    const result = { responseText: "Xin lỗi, tôi chưa thể trả lời câu hỏi này.", outputContexts: [] };
    // Lấy parameter chứa câu hỏi từ Dialogflow, dựa trên JSON bạn cung cấp là 'theory_question'
    const userQuestion = parameters.theory_question;

    if (!userQuestion) {
        result.responseText = "Bạn muốn hỏi tôi điều gì cụ thể?";
        return result;
    }

    console.log(`Handling User Theory Question (via theory_question param): "${userQuestion}"`);
    try {
    // BƯỚC 1: CỐ GẮNG TÌM CÂU HỎI KHỚP HOÀN TOÀN/GẦN ĐÚNG TRONG CSDL QUESTIONS
    // (Logic này có thể được tách ra hàm riêng nếu muốn)
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
        let foundAnswer = null;

        // 1a. Phân tích xem có phải là câu hỏi trắc nghiệm người dùng tự đặt không
        const parsedMCQ = parseUserMultipleChoiceQuestion(userQuestion); // Sử dụng câu hỏi gốc
        const questionContentToSearchForMCQ = parsedMCQ.questionContent;
        const userOptionsRaw = parsedMCQ.optionsRaw;
        const isUserMCQ = parsedMCQ.isMultipleChoice;

        if (isUserMCQ && questionContentToSearchForMCQ && userOptionsRaw.length > 0) {
            console.log("Attempting to match user's input as a known MCQ...");
            const queryContentRegex = new RegExp(questionContentToSearchForMCQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "i");
            const potentialDbMCQs = await questionsCollection.find({
                type: "multiple_choice",
                content: { $regex: queryContentRegex }
            }).limit(5).toArray();

            let bestMatch = null;
            let highestMCQMatchScore = 0.75; // Ngưỡng

            for (const dbMCQ of potentialDbMCQs) {
                let currentOptionScore = 0;
                if (dbMCQ.options && dbMCQ.options.length === userOptionsRaw.length) {
                    let matchedOptions = 0;
                    for (const userOptRaw of userOptionsRaw) {
                        const userOptLetter = userOptRaw.substring(0, 1).toUpperCase();
                        const userOptText = userOptRaw.substring(3).trim().toLowerCase();
                        if (dbMCQ.options.some(dbOptRaw => {
                            const dbOptLetter = dbOptRaw.substring(0, 1).toUpperCase();
                            const dbOptText = dbOptRaw.substring(3).trim().toLowerCase();
                            return dbOptLetter === userOptLetter && dbOptText.includes(userOptText);
                        })) {
                            matchedOptions++;
                        }
                    }
                    currentOptionScore = matchedOptions / dbMCQ.options.length;
                }
                if (currentOptionScore >= highestMCQMatchScore) {
                    highestMCQMatchScore = currentOptionScore;
                    bestMCQMatch = dbMCQ;
                }
            }
            if (bestMatch) {
                console.log(`Step 1: Found similar MCQ in DB (_id: ${bestMatch._id})`);
                foundAnswer = `Tôi tìm thấy câu hỏi này trong cơ sở dữ liệu của mình:\n"${bestMatch.content}"\n${(bestMatch.options || []).join("\n")}\nĐáp án đúng là: **${bestMatch.correct_answer}**.\n*Giải thích:* ${bestMatch.explanation || "Không có giải thích chi tiết."}`;
            }
        }

        // 1b. Nếu không phải MCQ hoặc không tìm thấy MCQ khớp, tìm câu hỏi lý thuyết khớp trong CSDL questions
        if (!foundAnswer) {
            const contentToSearchForTheory = questionContentToSearchForMCQ || userQuestion;
            const contentRegexForTheory = new RegExp(contentToSearchForTheory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "i");
            const dbTheoryQuestion = await questionsCollection.findOne({
                type: "theory",
                content: { $regex: contentRegexForTheory }
            });

            if (dbTheoryQuestion) {
                console.log(`Step 1: Found similar theory question in DB (_id: ${dbTheoryQuestion._id})`);
                foundAnswer = `Tôi tìm thấy một câu hỏi tương tự trong cơ sở dữ liệu:\n**Hỏi:** "${dbTheoryQuestion.content}"\n**Đáp:** ${dbTheoryQuestion.correct_answer}\n${dbTheoryQuestion.explanation || ""}`;
            }
        }

        // BƯỚC 2: NẾU KHÔNG TÌM THẤY CÂU HỎI KHỚP, TÌM THEO TỪ KHÓA TRONG CONCEPTS
        if (!foundAnswer) {
            console.log("Step 1: No direct question match. Proceeding to Step 2: Keyword search in concepts.");
            const keywords = extractKeywords(userQuestion); // Dùng câu hỏi gốc để trích từ khóa
            console.log("Extracted keywords for concept search:", keywords);

            if (keywords.length > 0) {
                // Cố gắng tìm một concept chính trước
                let mainConceptDoc = null;
                for (const keyword of keywords) {
                    const conceptDoc = await findConcept(keyword, conceptsCollection);
                    if (conceptDoc) {
                        mainConceptDoc = conceptDoc;
                        break;
                    }
                }

                if (mainConceptDoc) {
                    const conceptDisplayName = mainConceptDoc.name || keywords.find(k => String(k).toLowerCase() === String(mainConceptDoc.concept_id).toLowerCase() || (mainConceptDoc.aliases && mainConceptDoc.aliases.map(a => String(a).toLowerCase()).includes(String(k).toLowerCase()))) || keywords[0];

                    foundAnswer = `Về khái niệm "${conceptDisplayName}", tôi có thông tin sau:\n${mainConceptDoc.definition || ''}`;
                    if (mainConceptDoc.explanation_detailed) {
                        foundAnswer += `\n\nGiải thích chi tiết hơn: ${mainConceptDoc.explanation_detailed}`;
                    }

                    // Kiểm tra các từ khóa phụ trong câu hỏi của người dùng để cung cấp thông tin cụ thể hơn
                    const userQueryLower = userQuestion.toLowerCase();
                    let providedSpecificInfo = false;

                    if ((userQueryLower.includes("ví dụ") || userQueryLower.includes("cho ví dụ")) && mainConceptDoc.examples && mainConceptDoc.examples.length > 0) {
                        const exampleText = mainConceptDoc.examples.slice(0, 2).map(ex => `- (${ex.type || 'chung'}) ${ex.content}`).join('\n');
                        foundAnswer += `\n\nVí dụ liên quan:\n${exampleText}`;
                        providedSpecificInfo = true;
                    }

                    // Xử lý yêu cầu so sánh nếu có (phức tạp hơn vì cần concept thứ 2)
                    const comparisonMatch = userQueryLower.match(/so sánh(?: nó)? với ([^\s?.,]+)/i);
                    if (comparisonMatch && comparisonMatch[1]) {
                        const concept2ToCompare = comparisonMatch[1];
                        const concept2Doc = await findConcept(concept2ToCompare, conceptsCollection);
                        if (concept2Doc) {
                            let comparisonText = findComparisonTextInDoc(mainConceptDoc, concept2Doc.concept_id, concept2Doc.name);
                            if (!comparisonText) {
                                comparisonText = findComparisonTextInDoc(concept2Doc, mainConceptDoc.concept_id, mainConceptDoc.name);
                            }
                            if (comparisonText) {
                                foundAnswer += `\n\nSo sánh với ${concept2Doc.name || concept2ToCompare}:\n${comparisonText}`;
                                providedSpecificInfo = true;
                            } else {
                                 foundAnswer += `\n\n(Tôi chưa có thông tin so sánh trực tiếp với "${concept2Doc.name || concept2ToCompare}".)`;
                            }
                        } else {
                             foundAnswer += `\n\n(Tôi không tìm thấy thông tin về "${concept2ToCompare}" để so sánh.)`;
                        }
                    } else if ((userQueryLower.includes("so sánh") || userQueryLower.includes("khác gì")) && mainConceptDoc.comparison_points && mainConceptDoc.comparison_points.length > 0 && !providedSpecificInfo) {
                        // Nếu chỉ có 1 concept và yêu cầu so sánh, trả về các so sánh có sẵn
                        const availableComparisons = mainConceptDoc.comparison_points
                            .map(cp => `Với ${cp.compare_with_concept_id || cp.compare_with_name || 'khái niệm khác'}: ${cp.comparison_text}`)
                            .join('\n');
                        foundAnswer += `\n\n${mainConceptDoc.name || keyword} có thể được so sánh như sau:\n${availableComparisons}`;
                        providedSpecificInfo = true;
                    }
                    // Bạn có thể thêm các từ khóa khác như "mục đích", "cách phòng chống"...

                }
            }
        }

        // BƯỚC 3: TRẢ LỜI CUỐI CÙNG
        if (foundAnswer) {
            result.responseText = foundAnswer;
        } else {
            result.responseText = `Xin lỗi, tôi chưa có đủ thông tin để trả lời câu hỏi: "${userQuestion}". Bạn có thể thử hỏi về một khái niệm bảo mật cụ thể mà bạn quan tâm không?`;
        }

        // Đặt output context (ví dụ: theory_followup như trong JSON request)
        // Bạn có thể lưu các keywords hoặc concept chính tìm được vào context nếu muốn
        const sessionInfo = extractSessionInfo(sessionPath);
        console.log("Session Info:", sessionInfo);

        const contextId = 'theory_followup'; // Tên context từ JSON request
        const contextFullName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, contextId);
        result.outputContexts.push({
            name: contextFullName,
            lifespanCount: 2, // Hoặc một giá trị phù hợp
            parameters: {
                last_user_question: userQuestion, // Lưu lại câu hỏi
                // keywords_found: keywords // Lưu lại keywords nếu muốn
            }
        });


    } catch (error) {
        console.error("Error handling User Theory Question:", error);
        result.responseText = "Đã có lỗi xảy ra khi tôi cố gắng tìm câu trả lời cho bạn.";
    }
    return result;
}

// --- Hàm xử lý cho Action: answer_quiz_question ---
// (Xử lý câu hỏi TRẮC NGHIỆM do người dùng đặt - Chỉ tìm câu hỏi giống trong DB)
async function handleAskQuizQuestion(parameters, sessionPath) {
    const result = { responseText: "Xin lỗi, tôi chưa thể đánh giá câu hỏi trắc nghiệm này.", outputContexts: [] };

    const userQuestionContent = parameters.question;
    const userOptions = [];
    if (parameters.answerA) userOptions.push(String(parameters.answerA).trim());
    if (parameters.answerB) userOptions.push(String(parameters.answerB).trim());
    if (parameters.answerC) userOptions.push(String(parameters.answerC).trim());
    if (parameters.answerD) userOptions.push(String(parameters.answerD).trim());
    // Thêm answerE, answerF... nếu có

    if (!userQuestionContent || userOptions.length < 2) { // Cần ít nhất 2 lựa chọn
        result.responseText = "Bạn vui lòng cung cấp đầy đủ nội dung câu hỏi và ít nhất hai lựa chọn (A, B).";
        return result;
    }

    console.log(`Handling User Provided MCQ: "${userQuestionContent}"`);
    console.log("User Provided Options:", userOptions);

    try {
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION); // Cho fallback
        let foundAnswer = null;

        // Chuẩn hóa nội dung câu hỏi người dùng để tìm kiếm
        const queryContentForSearch = String(userQuestionContent).trim();
        // Tạo regex để tìm kiếm linh hoạt hơn, thoát các ký tự đặc biệt
        const contentRegex = new RegExp(queryContentForSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "i");

        // Tìm các câu hỏi tiềm năng trong CSDL
        const potentialMatches = await questionsCollection.find({
            type: "multiple_choice",
            content: { $regex: contentRegex }
        }).limit(10).toArray(); // Giới hạn số lượng kiểm tra

        let bestMatch = null;
        let highestMatchScore = 0.75; // Ngưỡng tương đồng tối thiểu (ví dụ 75%)

        for (const dbMCQ of potentialMatches) {
            if (!dbMCQ.options || dbMCQ.options.length !== userOptions.length) {
                continue; // Bỏ qua nếu số lượng lựa chọn không khớp
            }

            let matchedOptionsCount = 0;
            // So sánh từng lựa chọn
            for (let i = 0; i < userOptions.length; i++) {
                const userOptFull = userOptions[i]; // Ví dụ: "A. Ổ cứng cục bộ"
                const dbOptFull = dbMCQ.options[i];   // Ví dụ: "A. Ổ cứng cục bộ"

                // So sánh đơn giản dựa trên việc có bao gồm hay không (có thể cần tinh vi hơn)
                // Tách chữ cái và nội dung
                const userOptLetter = userOptFull.substring(0, 1).toUpperCase();
                const userOptText = userOptFull.substring(userOptFull.indexOf('.') + 1).trim().toLowerCase();

                const dbOptLetter = dbOptFull.substring(0, 1).toUpperCase();
                const dbOptText = dbOptFull.substring(dbOptFull.indexOf('.') + 1).trim().toLowerCase();

                // Yêu cầu cả chữ cái và nội dung phải tương đồng
                if (userOptLetter === dbOptLetter && dbOptText.includes(userOptText)) { // Hoặc một hàm so sánh tương đồng chuỗi tốt hơn
                    matchedOptionsCount++;
                }
            }

            const currentMatchScore = matchedOptionsCount / userOptions.length;

            if (currentMatchScore >= highestMatchScore) {
                highestMatchScore = currentMatchScore;
                bestMatch = dbMCQ;
            }
        }

        if (bestMatch) {
            console.log(`Found similar MCQ in DB (_id: ${bestMatch._id}) with option match score: ${highestMatchScore}`);
            foundAnswer = `Tôi tìm thấy câu hỏi này trong cơ sở dữ liệu của mình:\n**Hỏi:** "${bestMatch.content}"\n${(bestMatch.options || []).map(opt => `  ${opt}`).join("\n")}\n**Đáp án đúng là:** ${bestMatch.correct_answer}\n*Giải thích:* ${bestMatch.explanation || "Hiện chưa có giải thích chi tiết cho câu này."}`;
        } else {
            console.log("No highly similar MCQ found in DB by content and options.");
            // Nếu không tìm thấy câu trắc nghiệm khớp, có thể thử tìm thông tin lý thuyết liên quan
            const keywords = extractKeywords(userQuestionContent);
            if (keywords.length > 0) {
                let theoryInfo = "Xin lỗi, tôi không tìm thấy câu hỏi trắc nghiệm nào hoàn toàn giống với câu hỏi của bạn. ";
                for (const keyword of keywords) {
                    const conceptDoc = await findConcept(keyword, conceptsCollection);
                    if (conceptDoc) {
                        theoryInfo += `Tuy nhiên, tôi có thông tin về khái niệm "${conceptDoc.name}":\n${conceptDoc.definition}\nBạn có thể tham khảo thêm nhé.`;
                        // Chỉ lấy concept đầu tiên tìm được cho ngắn gọn
                        break;
                    }
                }
                if (theoryInfo.includes("Tuy nhiên")) {
                    foundAnswer = theoryInfo;
                } else {
                    foundAnswer = "Xin lỗi, tôi không tìm thấy câu hỏi trắc nghiệm nào giống với câu hỏi của bạn và cũng chưa có thông tin lý thuyết liên quan rõ ràng.";
                }
            } else {
                 foundAnswer = "Xin lỗi, tôi không tìm thấy câu hỏi trắc nghiệm nào giống với câu hỏi của bạn trong cơ sở dữ liệu.";
            }
        }

        result.responseText = foundAnswer;

        // Đặt output context (ví dụ: quiz_followup như trong JSON request)
        const sessionInfo = extractSessionInfo(sessionPath);
        const contextId = 'quiz_followup'; // Hoặc tên context bạn muốn
        const contextFullName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, contextId);
        result.outputContexts.push({
            name: contextFullName,
            lifespanCount: 2,
            parameters: { // Lưu lại các parameter gốc mà Dialogflow gửi
                question: userQuestionContent,
                answerA: parameters.answerA,
                answerB: parameters.answerB,
                answerC: parameters.answerC,
                answerD: parameters.answerD,
            }
        });


    } catch (error) {
        console.error("Error handling User Provided MCQ:", error);
        result.responseText = "Đã có lỗi xảy ra khi tôi cố gắng tìm câu trả lời cho câu hỏi trắc nghiệm của bạn.";
    }
    return result;
}

async function handleSubmitUserAnswersForList(parameters, inputContexts, sessionPath) {
    const result = { responseText: "Xin lỗi, tôi chưa thể nhận xét đáp án của bạn lúc này.", outputContexts: [] };

    const userAnswers = parameters.answer_choice; // Mảng ["A", "B", "C", "D", "A"]
    const questionNumbers = parameters.number;     // Mảng [1, 2, 3, 4, 5]

    // Tìm context chứa danh sách question_id
    // Dựa trên JSON của bạn, tên context là 'quiz_list_followup'
    // Hoặc tên context bạn đã đặt cho Output của RequestQuestionList, ví dụ 'context_question_list_active'
    const listContext = inputContexts.find(ctx =>
        (ctx.name.endsWith('/contexts/quiz_list_followup') || ctx.name.endsWith('/contexts/context_question_list_active')) &&
        ctx.parameters &&
        ctx.parameters.question_data // Đây là nơi bạn lưu mảng các { question_id: "..." }
    );

    if (!listContext || !listContext.parameters.question_data) {
        result.responseText = "Xin lỗi, tôi không tìm thấy danh sách câu hỏi bạn đang trả lời. Bạn có thể yêu cầu danh sách mới được không?";
        return result;
    }

    // question_data trong context bạn gửi là một mảng các object, mỗi object có key là question_id
    // Ví dụ: [{ "question_id": "68162c885b647869f5d5a5d1" }, ...]
    // Chúng ta cần lấy ra danh sách các ID này.
    let questionDataFromContext;
    try {
        // Nếu question_data đã là mảng object thì dùng trực tiếp
        // Nếu nó là chuỗi JSON (do cách lưu ở RequestQuestionList), thì cần parse
        if (typeof listContext.parameters.question_data === 'string') {
            questionDataFromContext = JSON.parse(listContext.parameters.question_data);
        } else {
            questionDataFromContext = listContext.parameters.question_data;
        }

        if (!Array.isArray(questionDataFromContext)) {
            throw new Error("question_data trong context không phải là mảng.");
        }
    } catch (e) {
        console.error("Lỗi parse question_data từ context:", e);
        result.responseText = "Có lỗi khi đọc dữ liệu câu hỏi từ context. Vui lòng thử lại.";
        return result;
    }

    // Trích xuất danh sách các ID từ context
    // Giả sử mỗi phần tử trong questionDataFromContext là { question_id: "some_id_string" }
    const questionIdsFromContext = questionDataFromContext.map(item => item.question_id);


    if (!userAnswers || !questionNumbers || userAnswers.length !== questionNumbers.length || userAnswers.length === 0) {
        result.responseText = "Có vẻ như bạn chưa cung cấp đủ thông tin đáp án hoặc số thứ tự câu hỏi. Vui lòng thử lại, ví dụ: '1A 2B 3C'.";
        return result;
    }

    console.log(`Handling user answers for list. User answers: ${JSON.stringify(userAnswers)}, Question numbers: ${JSON.stringify(questionNumbers)}`);
    console.log(`Question IDs from context: ${JSON.stringify(questionIdsFromContext)}`);


    try {
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        let correctCount = 0;
        let feedbackDetails = [];

        // Lấy chi tiết (bao gồm đáp án đúng) của các câu hỏi dựa trên ID từ context
        // Chuyển đổi questionIdsFromContext (string) thành ObjectId để query
        const objectIdsToQuery = questionIdsFromContext.map(idStr => {
            try {
                return new ObjectId(idStr);
            } catch (e) {
                console.error(`Invalid ObjectId string: ${idStr}`);
                return null; // hoặc xử lý lỗi khác
            }
        }).filter(id => id !== null); // Loại bỏ các ID không hợp lệ


        if (objectIdsToQuery.length !== questionIdsFromContext.length) {
            console.error("Một số question_id trong context không hợp lệ.");
            // Xử lý trường hợp này, có thể thông báo lỗi hoặc chỉ xử lý các ID hợp lệ
        }
        
        const dbQuestions = await questionsCollection.find({ _id: { $in: objectIdsToQuery } }).toArray();
        const dbQuestionsMap = dbQuestions.reduce((map, question) => {
            map[question._id.toString()] = question;
            return map;
        }, {});

        for (let i = 0; i < questionNumbers.length; i++) {
            const userQNumber = parseInt(questionNumbers[i], 10); // Số thứ tự người dùng nhập (1-based)
            const userAnswerChoice = String(userAnswers[i]).toUpperCase();

            // Lấy question_id tương ứng với số thứ tự người dùng nhập
            // (người dùng nhập "câu 1" thì index là 0 trong mảng questionIdsFromContext)
            if (userQNumber > 0 && userQNumber <= questionIdsFromContext.length) {
                const questionIdFromUserList = questionIdsFromContext[userQNumber - 1];
                const dbQuestion = dbQuestionsMap[questionIdFromUserList]; // Tra cứu bằng _id string

                if (dbQuestion) {
                    const correctAnswer = String(dbQuestion.correct_answer).toUpperCase();
                    if (userAnswerChoice === correctAnswer) {
                        correctCount++;
                        feedbackDetails.push(`Câu ${userQNumber}: ${userAnswerChoice} - Chính xác!`);
                    } else {
                        feedbackDetails.push(`Câu ${userQNumber}: ${userAnswerChoice} - Không đúng. Đáp án là ${correctAnswer}.`);
                    }
                } else {
                    feedbackDetails.push(`Câu ${userQNumber}: Không tìm thấy thông tin câu hỏi này trong danh sách đã cung cấp.`);
                }
            } else {
                feedbackDetails.push(`Câu ${userQNumber}: Số thứ tự không hợp lệ.`);
            }
        }

        if (feedbackDetails.length > 0) {
            const totalAnswered = questionNumbers.length;
            result.responseText = `Kết quả của bạn:\n${feedbackDetails.join("\n")}\n\nTổng kết: Bạn đã đúng ${correctCount}/${totalAnswered} câu.`;
        } else {
            result.responseText = "Tôi không nhận được đáp án nào hợp lệ để nhận xét.";
        }

        // Xóa context context_question_list_active (hoặc quiz_list_followup) sau khi đã nhận xét
        const sessionInfo = extractSessionInfo(sessionPath);
        const contextNameToClear = listContext.name.split('/').pop(); // Lấy tên ngắn của context đã dùng
        const contextFullNameToClear = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, contextNameToClear);
        result.outputContexts.push({
            name: contextFullNameToClear,
            lifespanCount: 0 // Xóa context
        });
        console.log(`Clearing context: ${contextFullNameToClear}`);


    } catch (error) {
        console.error("Error handling handleSubmitUserAnswersForList:", error);
        result.responseText = "Đã có lỗi xảy ra khi nhận xét đáp án của bạn.";
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
                handlerResult = await handleGiveDefinition(parameters, sessionPath, false);
                  break;
              case 'give_definition_detailed':
                handlerResult = await handleGiveDefinition(parameters, sessionPath, true);
                  break;
            case 'compare_topics':
                handlerResult = await handleComparison(parameters);
                break;
            case 'give_example': // Bạn có thể gộp nếu logic xử lý ví dụ là chung
                handlerResult = await handleGiveExample(parameters); // Hàm này cần xử lý cả context
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
                  case 'decline_quiz_explanation_after_answer': // Hoặc tên action bạn đặt cho Intent "No"
                  console.log("User declined explanation after answers.");
                  handlerResult.responseText = "Được rồi. Bạn có cần tôi hỗ trợ gì khác không?"; // Hoặc một câu chào kết thúc phù hợp
  
                  const sessionInfoNo = extractSessionInfo(sessionPath);
                  
                  // 1. Xóa context xác nhận vì nó đã được xử lý
                  const confirmContextNameToClear = buildContextName(sessionInfoNo.projectId, sessionInfoNo.sessionId, 'quiz_explanation_confirm');
                  
                  // 2. Quyết định về context quiz_list_followup:
                  // Option A: Để quiz_list_followup tự hết hạn hoặc người dùng tự kết thúc bằng một intent khác.
                  // Option B: Chủ động làm mới quiz_list_followup nếu bạn muốn người dùng có thể hỏi lại về quiz đó.
                  // Option C: Chủ động xóa quiz_list_followup nếu "không" đồng nghĩa với việc kết thúc hoàn toàn với quiz này.
  
                  // Ví dụ: Xóa context xác nhận và không làm gì với quiz_list_followup (để nó tự nhiên)
                  handlerResult.outputContexts = [
                      { name: confirmContextNameToClear, lifespanCount: 0, parameters: {} }
                      // Nếu bạn muốn làm mới quiz_list_followup, bạn cần lấy parameters của nó
                      // từ `inputContexts` hoặc `parameters` (nếu Dialogflow truyền) và đặt lại.
                      // Ví dụ làm mới (cần cẩn thận để lấy đúng parameters):
                      // const activeQuizContext = inputContexts.find(ctx => ctx.name.endsWith('/contexts/quiz_list_followup'));
                      // if (activeQuizContext) {
                      //     handlerResult.outputContexts.push({
                      //         name: activeQuizContext.name,
                      //         lifespanCount: 5, // Làm mới lifespan
                      //         parameters: activeQuizContext.parameters
                      //     });
                      // }
                  ];
                  break;
            case 'explain_quiz':
                handlerResult = await handleAskExplanationForList(parameters, inputContexts, sessionPath);
                  break;
              case 'answer_quiz_question':
                handlerResult = await handleAskQuizQuestion(parameters, sessionPath);
                  break;
              case 'answer_theory_question':
                handlerResult = await handleAskTheoryQuestion(parameters, sessionPath);
                  break;
              case 'submit_quiz_question':
                  handlerResult = await handleSubmitUserAnswersForList(parameters, inputContexts, sessionPath);
                  break;
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