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
async function handleAskDefinition(parameters, sessionPath) {
    const result = { responseText: "Xin lỗi, tôi chưa hiểu ý bạn.", outputContexts: [] };
    const conceptParam = parameters.concept;

    if (!conceptParam) {
        result.responseText = "Xin lỗi, bạn muốn hỏi về khái niệm nào?";
        return result;
    }

    try {
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
        const conceptDoc = await findConcept(conceptParam, conceptsCollection);

        if (conceptDoc && conceptDoc.definition) {
            result.responseText = `${conceptDoc.name || conceptParam}:\n${conceptDoc.definition}`;
            // Thiết lập output context
            const sessionInfo = extractSessionInfo(sessionPath);
            const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_concept_defined');
            const conceptIdentifier = conceptDoc.concept_id || conceptDoc.name; // Dùng ID chuẩn nếu có

            result.outputContexts.push({
                name: contextName,
                lifespanCount: 2,
                parameters: { concept: conceptIdentifier }
            });
            console.log(`Setting Output Context: ${contextName} with concept: ${conceptIdentifier}`);
        } else {
            result.responseText = `Xin lỗi, tôi chưa tìm thấy định nghĩa cho "${conceptParam}".`;
        }
    } catch (error) {
        console.error("Error querying definition:", error);
        result.responseText = "Đã có lỗi xảy ra khi tìm định nghĩa.";
    }
    return result;
}

async function handleAskComparison(parameters) {
    const result = { responseText: "Xin lỗi, tôi chưa hiểu ý bạn.", outputContexts: [] };
    console.log(parameters)
    const concepts = parameters.concept;
    const concept1 = concepts[0];
    const concept2 = concepts[1];

    if (!concept1 || !concept2) {
        result.responseText = "Xin lỗi, bạn muốn so sánh giữa hai khái niệm nào?";
        return result;
    }

    try {
        const conceptsCollection = db.collection(CONCEPTS_COLLECTION);
        const findComparisonText = (doc, targetConcept) => {
            // ... (logic tìm comparison_points như code trước) ...
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
    // concept sẽ được điền từ user input hoặc từ context thông qua Default Value
    const conceptParam = parameters.concept;
    const exampleTypeParam = parameters.example_type; // Lấy type nếu có

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
                    // Nếu không có loại ví dụ đó, có thể báo lại hoặc trả về ví dụ mặc định
                     result.responseText = `Tôi không có ví dụ loại "${exampleTypeParam}" cho "${conceptDoc.name || conceptParam}". Đây là các ví dụ khác:\n`;
                     // Để trống exampleText để nối ví dụ mặc định bên dưới
                }
            }

            const exampleText = examplesToReturn.slice(0, 2) // Lấy tối đa 2 ví dụ
                .map(ex => `- ${ex.content}`)
                .join('\n');

             // Nếu responseText đã có thông báo lỗi loại ví dụ thì nối thêm, nếu không thì tạo mới
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


// Nhóm 2: Trắc nghiệm đơn lẻ (Giữ nguyên logic dùng context đơn lẻ)
// Nhóm 2: Trắc nghiệm đơn lẻ
async function handleRequestSingleQuestion(parameters, sessionPath) {
    const result = { responseText: "Có lỗi khi lấy câu hỏi.", outputContexts: [] };
    try {
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        const questions = await getRandomQuestions({ ...parameters, number: 1 }, questionsCollection); // Lấy 1 câu

        if (questions && questions.length > 0) {
            const question = questions[0];
            let optionsText = "";
            if (question.options && question.options.length > 0) {
                 optionsText = "\n" + question.options.join("\n"); // Format A. B. C. D.
            }
            result.responseText = `Câu hỏi: ${question.content}${optionsText}\nHãy chọn đáp án (A, B, C, D).`;

            // Thiết lập context chờ trả lời
            const sessionInfo = extractSessionInfo(sessionPath);
            const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_awaiting_single_answer');
            result.outputContexts.push({
                name: contextName,
                lifespanCount: 2, // Chờ 2 lượt
                parameters: {
                    question_id: question.question_id,
                    correct_answer: question.correct_answer,
                    explanation: question.explanation
                }
            });
             console.log(`Setting Output Context: ${contextName} for question: ${question.question_id}`);
        } else {
            result.responseText = "Xin lỗi, tôi không tìm thấy câu hỏi nào phù hợp với yêu cầu của bạn.";
        }
    } catch (error) {
        console.error("Error handling RequestSingleQuestion:", error);
        result.responseText = "Đã có lỗi xảy ra khi lấy câu hỏi trắc nghiệm.";
    }
    return result;
}

async function handleAnswerSingleQuestion(parameters, inputContexts, sessionPath) {
    const result = { responseText: "Lỗi khi kiểm tra đáp án.", outputContexts: [] };
    const userAnswer = parameters.answer; // Giả sử entity @answer_choice trả về A, B, C, D

    // Tìm context chứa thông tin câu hỏi
    const context = inputContexts.find(ctx => ctx.name.endsWith('/contexts/context_awaiting_single_answer'));

    if (!context || !context.parameters || !context.parameters.question_id || !context.parameters.correct_answer) {
        result.responseText = "Xin lỗi, tôi không rõ bạn đang trả lời câu hỏi nào. Hãy thử yêu cầu câu hỏi mới.";
        return result;
    }

    const { question_id, correct_answer, explanation } = context.parameters;
    const isCorrect = String(userAnswer).toUpperCase() === String(correct_answer).toUpperCase();

    if (isCorrect) {
        result.responseText = `Chính xác! ${explanation || ''}\nBạn có muốn câu hỏi khác không?`;
    } else {
        result.responseText = `Không đúng. Đáp án đúng là ${correct_answer}. ${explanation || ''}\nBạn có muốn câu hỏi khác không?`;
    }

     // Có thể đặt context mới để cho phép hỏi giải thích chi tiết hơn nếu cần
     // const sessionInfo = extractSessionInfo(sessionPath);
     // const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_single_Youtubeed');
     // result.outputContexts.push({
     //      name: contextName,
     //      lifespanCount: 1,
     //      parameters: { question_id: question_id, is_correct: isCorrect }
     // });

    // Không cần xóa context_awaiting_single_answer vì lifespan của nó sẽ tự giảm

    // TODO: Lưu tiến trình vào CSDL users nếu cần
    // const userId = extractUserIdFromSession(sessionPath); // Cần hàm để lấy User ID
    // saveSingleAnswerToUser(userId, question_id, userAnswer, isCorrect);

    return result;
}

async function handleExplainSingleQuestion(parameters, inputContexts) {
     const result = { responseText: "Lỗi khi lấy giải thích.", outputContexts: [] };

     // Ưu tiên lấy từ context_awaiting_single_answer hoặc context_single_Youtubeed
     const context = inputContexts.find(ctx =>
         ctx.name.endsWith('/contexts/context_awaiting_single_answer') ||
         ctx.name.endsWith('/contexts/context_single_Youtubeed')
     );

     if (!context || !context.parameters || !context.parameters.explanation) {
          // Nếu không có trong context, thử lấy question_id và query DB
          const qidContext = inputContexts.find(ctx => ctx.parameters && ctx.parameters.question_id);
          if (qidContext && qidContext.parameters.question_id) {
              const question = await getQuestionDetails(qidContext.parameters.question_id, db.collection(QUESTIONS_COLLECTION));
              if (question && question.explanation) {
                   result.responseText = question.explanation;
              } else {
                   result.responseText = "Xin lỗi, tôi không tìm thấy giải thích cho câu hỏi này.";
              }
          } else {
               result.responseText = "Xin lỗi, tôi không rõ bạn muốn giải thích câu hỏi nào.";
          }
     } else {
          result.responseText = context.parameters.explanation;
     }

     return result;
}



// Nhóm 3: Thi trắc nghiệm thử (Logic thay đổi HOÀN TOÀN)
async function handleStartQuiz(parameters, sessionPath) {
    const result = { responseText: "Có lỗi khi bắt đầu bài thi.", outputContexts: [] };
     try {
        const questionsCollection = db.collection(QUESTIONS_COLLECTION);
        const questions = await getRandomQuestions(parameters, questionsCollection);

        if (!questions || questions.length === 0) {
            result.responseText = "Xin lỗi, tôi không tìm thấy câu hỏi nào phù hợp để tạo bài thi.";
            return result;
        }

        // **THAY ĐỔI:** Tạo trạng thái quiz ban đầu để lưu vào context
        const quizState = {
             quiz_id: uuidv4(), // ID logic cho phiên quiz này (không lưu DB)
             status: "ongoing",
             topic: parameters.topic || null,
             difficulty: parameters.difficulty || null,
             questions: questions, // Mảng chứa đầy đủ thông tin câu hỏi
             total_questions: questions.length,
             current_question_index: 0,
             score: 0,
             start_time: new Date().toISOString() // Lưu dạng ISO string cho JSON
        };

        // Lấy câu hỏi đầu tiên
        const firstQuestion = quizState.questions[0];
        let optionsText = "\n" + (firstQuestion.options || []).join("\n");
        result.responseText = `Bắt đầu bài thi! (${quizState.total_questions} câu)\nCâu 1: ${firstQuestion.content}${optionsText}`;

        // **THAY ĐỔI:** Thiết lập context và nhúng TOÀN BỘ quizState vào parameters
        const sessionInfo = extractSessionInfo(sessionPath);
        const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_in_quiz');

        // Chuyển state thành chuỗi JSON để đảm bảo truyền đúng qua context
        const quizStateString = JSON.stringify(quizState);
         // KIỂM TRA KÍCH THƯỚC (Tùy chọn nhưng nên làm)
         if (Buffer.byteLength(quizStateString, 'utf8') > 10000) { // Giới hạn ví dụ 10KB
              console.warn("Quiz state size might exceed context limits!");
              // Có thể trả về lỗi hoặc chỉ lưu ID câu hỏi thay vì toàn bộ data
              result.responseText = "Lỗi: Bài thi quá lớn để bắt đầu theo cách này.";
              return result;
         }

        result.outputContexts.push({
            name: contextName,
            lifespanCount: 15, // Vòng đời dài, cần reset
            parameters: {
                // Lưu toàn bộ trạng thái vào MỘT parameter dạng chuỗi JSON
                quiz_state: quizStateString
            }
        });
         console.log(`Setting context_in_quiz with state for quiz: ${quizState.quiz_id}`);

    } catch (error) {
        console.error("Error handling StartQuiz:", error);
        result.responseText = "Đã có lỗi xảy ra khi bắt đầu bài thi.";
    }
    return result;
}

async function handleAnswerQuizQuestion(parameters, inputContexts, sessionPath) {
     const result = { responseText: "Lỗi khi xử lý câu trả lời.", outputContexts: [] };
     const userAnswer = parameters.answer;

     // **THAY ĐỔI:** Lấy trạng thái quiz từ context
     const context = inputContexts.find(ctx => ctx.name.endsWith('/contexts/context_in_quiz'));
     if (!context || !context.parameters || !context.parameters.quiz_state) {
         result.responseText = "Có lỗi xảy ra, không tìm thấy trạng thái bài thi của bạn. Hãy thử bắt đầu lại.";
         return result;
     }

     let quizState;
     try {
         quizState = JSON.parse(context.parameters.quiz_state); // Parse lại state
     } catch (e) {
         console.error("Error parsing quiz_state from context:", e);
         result.responseText = "Lỗi đọc trạng thái bài thi.";
         return result;
     }

     // Kiểm tra trạng thái hợp lệ
     if (quizState.status !== "ongoing") {
         result.responseText = "Bài thi này đã kết thúc.";
         return result;
     }

     const currentIndex = quizState.current_question_index;
     // Đảm bảo index hợp lệ (phòng trường hợp lỗi context)
     if (currentIndex >= quizState.total_questions || currentIndex < 0) {
          console.error(`Invalid current_question_index: ${currentIndex} in quiz ${quizState.quiz_id}`);
          result.responseText = "Có lỗi với thứ tự câu hỏi, vui lòng bắt đầu lại.";
           // Xóa context lỗi
           const sessionInfo = extractSessionInfo(sessionPath);
           const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_in_quiz');
           result.outputContexts.push({ name: contextName, lifespanCount: 0 });
          return result;
     }
     const currentQuestion = quizState.questions[currentIndex];

     // Kiểm tra đáp án
     const isCorrect = String(userAnswer).toUpperCase() === String(currentQuestion.correct_answer).toUpperCase();
     if (isCorrect) {
         quizState.score++;
     }

     // **THAY ĐỔI:** Cập nhật trạng thái ngay trong object quizState
     quizState.questions[currentIndex].user_answer = userAnswer;
     quizState.questions[currentIndex].is_correct = isCorrect;
     quizState.current_question_index++; // Tăng index cho câu tiếp theo

     // Chuyển sang câu hỏi tiếp theo hay kết thúc?
     const nextIndex = quizState.current_question_index;

     if (nextIndex < quizState.total_questions) {
         // Còn câu hỏi -> Hiển thị câu tiếp theo
         const nextQuestion = quizState.questions[nextIndex];
         let optionsText = "\n" + (nextQuestion.options || []).join("\n");
         result.responseText = `Câu ${nextIndex + 1}: ${nextQuestion.content}${optionsText}`;

         // **THAY ĐỔI:** Reset lại context với quizState ĐÃ ĐƯỢC CẬP NHẬT
         const sessionInfo = extractSessionInfo(sessionPath);
         const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_in_quiz');
         const updatedQuizStateString = JSON.stringify(quizState);
          // Kiểm tra lại kích thước nếu cần
         result.outputContexts.push({
             name: contextName,
             lifespanCount: 15, // Reset lifespan
             parameters: { quiz_state: updatedQuizStateString }
         });
         console.log(`Updating context_in_quiz for quiz: ${quizState.quiz_id}, next index: ${nextIndex}`);

     } else {
         // Hết câu hỏi -> Kết thúc thi
         quizState.status = "completed";
         quizState.end_time = new Date().toISOString();
         const finalScore = quizState.score;
         const percentage = (finalScore / quizState.total_questions) * 100;
         result.responseText = `Bài thi kết thúc!\nBạn đã trả lời đúng ${finalScore}/${quizState.total_questions} câu (${percentage.toFixed(0)}%).`;

         console.log(`Quiz completed: ${quizState.quiz_id}, Score: ${finalScore}/${quizState.total_questions}`);
         // Không cần lưu DB, không cần set lại context_in_quiz (nó sẽ tự hết hạn)
     }

     return result;
}

async function handleEndQuiz(parameters, inputContexts, sessionPath) {
     const result = { responseText: "Bạn hiện không ở trong bài thi nào.", outputContexts: [] };
     // Lấy trạng thái quiz từ context
     const context = inputContexts.find(ctx => ctx.name.endsWith('/contexts/context_in_quiz'));
     if (!context || !context.parameters || !context.parameters.quiz_state) {
          return result;
     }

     let quizState;
     try {
          quizState = JSON.parse(context.parameters.quiz_state);
     } catch (e) {
          console.error("Error parsing quiz_state from context in EndQuiz:", e);
          // Xóa context lỗi
           const sessionInfo = extractSessionInfo(sessionPath);
           const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_in_quiz');
           result.outputContexts.push({ name: contextName, lifespanCount: 0 });
          result.responseText = "Lỗi đọc trạng thái bài thi để kết thúc.";
          return result;
     }

     // Tính toán kết quả cuối cùng (dù có thể đã tính ở câu cuối)
     const finalScore = quizState.score;
     const totalQuestions = quizState.total_questions;
     const percentage = totalQuestions > 0 ? (finalScore / totalQuestions) * 100 : 0;
     result.responseText = `Bài thi đã kết thúc.\nKết quả: ${finalScore}/${totalQuestions} câu đúng (${percentage.toFixed(0)}%).`;

     console.log(`Quiz ended by user: ${quizState.quiz_id}, Score: ${finalScore}/${totalQuestions}`);

     // **THAY ĐỔI:** Chỉ cần xóa context là đủ, không cần cập nhật DB
     const sessionInfo = extractSessionInfo(sessionPath);
     const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_in_quiz');
     result.outputContexts.push({ name: contextName, lifespanCount: 0 }); // Set lifespan = 0 để xóa

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
            const contextName = buildContextName(sessionInfo.projectId, sessionInfo.sessionId, 'context_question_list_active');
            

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
          return res.status(400).json({ error: 'question_data phải là mảng.' });
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


// --- Endpoint Webhook Chính ---
app.post('/webhook', async (req, res) => {
    // ... (Phần này giữ nguyên logic switch case, nhưng case sẽ gọi các hàm handler đã được chỉnh sửa ở trên) ...

     if (!db) { await connectDB(); }
     if (!db) { return res.status(500).json({ fulfillmentText: "Lỗi nghiêm trọng: Không thể kết nối cơ sở dữ liệu." }); }

     const queryResult = req.body.queryResult;
     const intentName = queryResult.intent.displayName;
     const parameters = queryResult.parameters;
     const sessionPath = req.body.session;
     const inputContexts = req.body.queryResult.outputContexts || [];

     console.log(`[${new Date().toISOString()}] Intent: ${intentName}, Session: ${sessionPath}`);

     let handlerResult = { responseText: "Xin lỗi, tôi chưa hiểu rõ yêu cầu của bạn.", outputContexts: [] };

     try {
          // !!! THAY THẾ TÊN INTENT TRONG CASE BẰNG TÊN THỰC TẾ TRONG DIALOGFLOW !!!
          switch (intentName) {
               // Nhóm 1
               case 'AskDefinition': // <-- Thay tên
                     handlerResult = await handleAskDefinition(parameters, sessionPath);
                     break;
               case 'AskComparison': // <-- Thay tên
                     handlerResult = await handleAskComparison(parameters);
                     break;
               case 'AskExample_FollowUp': // <-- Thay tên (Hoặc AskExample_FollowUp nếu tách)
                     handlerResult = await handleAskExample(parameters);
                     break;
               case 'AskExample_Direct': // <-- Nếu tách Intent
                    handlerResult = await handleAskExample(parameters);
                    break;
               // Nhóm 3 (Đã sửa logic để dùng context)
               case 'StartQuiz': // <-- Thay tên
                     handlerResult = await handleStartQuiz(parameters, sessionPath);
                     break;
               case 'AnswerQuizQuestion': // <-- Thay tên
                     handlerResult = await handleAnswerQuizQuestion(parameters, inputContexts, sessionPath);
                     break;
               case 'EndQuiz': // <-- Thay tên
                     handlerResult = await handleEndQuiz(parameters, inputContexts, sessionPath);
                     break;

               // Nhóm 4 (Giữ nguyên logic dùng context)
               case 'RequestQuestionList': // <-- Thay tên
                    handlerResult = await handleRequestQuestionList(parameters, sessionPath);
                    break;
               case 'AskAnswerForList': // <-- Thay tên
                    handlerResult = await handleAskAnswerForList(parameters, inputContexts, sessionPath);
                    break;
               case 'AskExplanationForList': // <-- Thay tên
                    handlerResult = await handleAskExplanationForList(parameters, inputContexts, sessionPath);
                    break;
               default:
                     console.log(`Intent ${intentName} chưa được xử lý bởi webhook.`);
                     handlerResult.responseText = `Tôi chưa được lập trình để xử lý yêu cầu '${intentName}'.`;
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