export interface FeedbackStrings {
  flagPlaceholder: string;
  submit: string;
  cancel: string;
  thanksConfirmation: string;
  submitError: string;
  disclaimer: string;
}

// Hand-authored translations for the small set of feedback-flagging UI strings.
// Not reviewed by native speakers — worth a review pass before relying on them
// in a live service (see the design doc's "Known Simplifications").
const FEEDBACK_STRINGS: Record<string, FeedbackStrings> = {
  zh: {
    flagPlaceholder: '可选:这一行有什么问题?',
    submit: '提交',
    cancel: '取消',
    thanksConfirmation: '谢谢,已标记',
    submitError: '发送失败,请重试',
    disclaimer: '翻译可能不准确。这是一个演示应用。如有错误,请点击旗帜图标举报。',
  },
  id: {
    flagPlaceholder: 'Opsional: apa yang salah dengan baris ini?',
    submit: 'Kirim',
    cancel: 'Batal',
    thanksConfirmation: 'Terima kasih, sudah ditandai',
    submitError: 'Gagal mengirim — coba lagi',
    disclaimer: 'Terjemahan mungkin tidak akurat. Ini adalah aplikasi demo. Jika ada kesalahan, klik bendera untuk melaporkannya.',
  },
  tl: {
    flagPlaceholder: 'Opsyonal: ano ang mali sa linyang ito?',
    submit: 'Ipadala',
    cancel: 'Kanselahin',
    thanksConfirmation: 'Salamat, na-flag na',
    submitError: 'Hindi naipadala — subukan muli',
    disclaimer: 'Maaaring hindi tumpak ang mga pagsasalin. Ito ay isang demo app. Kung may mali, i-click ang bandila para mag-report.',
  },
  ko: {
    flagPlaceholder: '선택 사항: 이 줄에 어떤 문제가 있나요?',
    submit: '제출',
    cancel: '취소',
    thanksConfirmation: '감사합니다, 신고되었습니다',
    submitError: '전송 실패 — 다시 시도해주세요',
    disclaimer: '번역이 정확하지 않을 수 있습니다. 이것은 데모 앱입니다. 오류가 있으면 깃발을 클릭하여 신고해 주세요.',
  },
  ja: {
    flagPlaceholder: '任意:この行の何が問題ですか?',
    submit: '送信',
    cancel: 'キャンセル',
    thanksConfirmation: 'ありがとうございます、報告されました',
    submitError: '送信できませんでした もう一度お試しください',
    disclaimer: '翻訳は正確でない場合があります。これはデモアプリです。誤りがあれば、旗のアイコンをクリックして報告してください。',
  },
  vi: {
    flagPlaceholder: 'Không bắt buộc: dòng này có vấn đề gì?',
    submit: 'Gửi',
    cancel: 'Hủy',
    thanksConfirmation: 'Cảm ơn, đã được gắn cờ',
    submitError: 'Gửi không thành công — vui lòng thử lại',
    disclaimer: 'Bản dịch có thể không chính xác. Đây là ứng dụng demo. Nếu có lỗi, hãy nhấp vào cờ để báo cáo.',
  },
  th: {
    flagPlaceholder: 'ไม่บังคับ: บรรทัดนี้มีปัญหาอะไร?',
    submit: 'ส่ง',
    cancel: 'ยกเลิก',
    thanksConfirmation: 'ขอบคุณ ถูกทำเครื่องหมายแล้ว',
    submitError: 'ส่งไม่สำเร็จ — ลองอีกครั้ง',
    disclaimer: 'คำแปลอาจไม่ถูกต้อง นี่คือแอปเดโม หากพบข้อผิดพลาด กรุณาคลิกที่ธงเพื่อรายงาน',
  },
  es: {
    flagPlaceholder: 'Opcional: ¿qué está mal en esta línea?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Gracias, marcado',
    submitError: 'No se pudo enviar — inténtalo de nuevo',
    disclaimer: 'Las traducciones pueden no ser precisas. Esta es una aplicación de demostración. Si hay algún error, haz clic en la bandera para reportarlo.',
  },
  pt: {
    flagPlaceholder: 'Opcional: o que está errado nesta linha?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Obrigado, sinalizado',
    submitError: 'Falha ao enviar — tente novamente',
    disclaimer: 'As traduções podem não ser precisas. Este é um aplicativo de demonstração. Se houver erros, clique na bandeira para reportar.',
  },
  fr: {
    flagPlaceholder: "Facultatif : qu'est-ce qui ne va pas avec cette ligne ?",
    submit: 'Envoyer',
    cancel: 'Annuler',
    thanksConfirmation: 'Merci, signalé',
    submitError: "Échec de l'envoi — réessayez",
    disclaimer: "Les traductions peuvent être inexactes. Ceci est une application de démonstration. En cas d'erreur, cliquez sur le drapeau pour la signaler.",
  },
  hi: {
    flagPlaceholder: 'वैकल्पिक: इस पंक्ति में क्या गलत है?',
    submit: 'भेजें',
    cancel: 'रद्द करें',
    thanksConfirmation: 'धन्यवाद, फ़्लैग कर दिया गया',
    submitError: 'भेजने में विफल — पुनः प्रयास करें',
    disclaimer: 'अनुवाद सटीक नहीं हो सकते हैं। यह एक डेमो ऐप है। यदि कोई त्रुटि हो, तो रिपोर्ट करने के लिए फ़्लैग पर क्लिक करें।',
  },
  my: {
    flagPlaceholder: 'ချန်ထားနိုင်သည်: ဒီစာကြောင်းမှာ ဘာမှားနေလဲ?',
    submit: 'ပို့ရန်',
    cancel: 'ပယ်ဖျက်ရန်',
    thanksConfirmation: 'ကျေးဇူးတင်ပါသည်၊ အမှတ်အသားပြုပြီးပါပြီ',
    submitError: 'ပို့၍မရပါ — ထပ်စမ်းကြည့်ပါ',
    disclaimer: 'ဘာသာပြန်ချက်များသည် တိကျမှုမရှိနိုင်ပါ။ ဤသည်မှာ သရုပ်ပြအက်ပ်တစ်ခုဖြစ်သည်။ အမှားများရှိပါက အလံကိုနှိပ်၍ အစီရင်ခံပါ။',
  },
};

export const EN_FALLBACK: FeedbackStrings = {
  flagPlaceholder: "Optional: what's wrong with this line?",
  submit: 'Submit',
  cancel: 'Cancel',
  thanksConfirmation: 'Thanks, flagged',
  submitError: "Couldn't send — try again",
  disclaimer: 'Translations may not be accurate. This is a demo app. If you see an error, click the flag to report it.',
};

export function getFeedbackStrings(languageCode: string): FeedbackStrings {
  return FEEDBACK_STRINGS[languageCode] ?? EN_FALLBACK;
}
