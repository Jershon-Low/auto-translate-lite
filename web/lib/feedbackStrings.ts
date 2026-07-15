export interface FeedbackStrings {
  flagPlaceholder: string;
  submit: string;
  cancel: string;
  thanksConfirmation: string;
  submitError: string;
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
  },
  id: {
    flagPlaceholder: 'Opsional: apa yang salah dengan baris ini?',
    submit: 'Kirim',
    cancel: 'Batal',
    thanksConfirmation: 'Terima kasih, sudah ditandai',
    submitError: 'Gagal mengirim — coba lagi',
  },
  tl: {
    flagPlaceholder: 'Opsyonal: ano ang mali sa linyang ito?',
    submit: 'Ipadala',
    cancel: 'Kanselahin',
    thanksConfirmation: 'Salamat, na-flag na',
    submitError: 'Hindi naipadala — subukan muli',
  },
  ko: {
    flagPlaceholder: '선택 사항: 이 줄에 어떤 문제가 있나요?',
    submit: '제출',
    cancel: '취소',
    thanksConfirmation: '감사합니다, 신고되었습니다',
    submitError: '전송 실패 — 다시 시도해주세요',
  },
  ja: {
    flagPlaceholder: '任意:この行の何が問題ですか?',
    submit: '送信',
    cancel: 'キャンセル',
    thanksConfirmation: 'ありがとうございます、報告されました',
    submitError: '送信できませんでした もう一度お試しください',
  },
  vi: {
    flagPlaceholder: 'Không bắt buộc: dòng này có vấn đề gì?',
    submit: 'Gửi',
    cancel: 'Hủy',
    thanksConfirmation: 'Cảm ơn, đã được gắn cờ',
    submitError: 'Gửi không thành công — vui lòng thử lại',
  },
  th: {
    flagPlaceholder: 'ไม่บังคับ: บรรทัดนี้มีปัญหาอะไร?',
    submit: 'ส่ง',
    cancel: 'ยกเลิก',
    thanksConfirmation: 'ขอบคุณ ถูกทำเครื่องหมายแล้ว',
    submitError: 'ส่งไม่สำเร็จ — ลองอีกครั้ง',
  },
  es: {
    flagPlaceholder: 'Opcional: ¿qué está mal en esta línea?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Gracias, marcado',
    submitError: 'No se pudo enviar — inténtalo de nuevo',
  },
  pt: {
    flagPlaceholder: 'Opcional: o que está errado nesta linha?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Obrigado, sinalizado',
    submitError: 'Falha ao enviar — tente novamente',
  },
  fr: {
    flagPlaceholder: "Facultatif : qu'est-ce qui ne va pas avec cette ligne ?",
    submit: 'Envoyer',
    cancel: 'Annuler',
    thanksConfirmation: 'Merci, signalé',
    submitError: "Échec de l'envoi — réessayez",
  },
  hi: {
    flagPlaceholder: 'वैकल्पिक: इस पंक्ति में क्या गलत है?',
    submit: 'भेजें',
    cancel: 'रद्द करें',
    thanksConfirmation: 'धन्यवाद, फ़्लैग कर दिया गया',
    submitError: 'भेजने में विफल — पुनः प्रयास करें',
  },
  my: {
    flagPlaceholder: 'ချန်ထားနိုင်သည်: ဒီစာကြောင်းမှာ ဘာမှားနေလဲ?',
    submit: 'ပို့ရန်',
    cancel: 'ပယ်ဖျက်ရန်',
    thanksConfirmation: 'ကျေးဇူးတင်ပါသည်၊ အမှတ်အသားပြုပြီးပါပြီ',
    submitError: 'ပို့၍မရပါ — ထပ်စမ်းကြည့်ပါ',
  },
};

const EN_FALLBACK: FeedbackStrings = {
  flagPlaceholder: "Optional: what's wrong with this line?",
  submit: 'Submit',
  cancel: 'Cancel',
  thanksConfirmation: 'Thanks, flagged',
  submitError: "Couldn't send — try again",
};

export function getFeedbackStrings(languageCode: string): FeedbackStrings {
  return FEEDBACK_STRINGS[languageCode] ?? EN_FALLBACK;
}
