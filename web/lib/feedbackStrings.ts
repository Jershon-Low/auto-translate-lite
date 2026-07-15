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
    disclaimer: '警告:翻译内容可能存在错误。这是一个自动翻译系统的实时演示,翻译文本由系统自动生成,未经人工审核。它可能偶尔会不准确、不完整或翻译错误。如果您发现某行翻译有误,请点击该行旁边的旗帜(⚑)图标进行举报——您的反馈将帮助我们改进系统。',
  },
  id: {
    flagPlaceholder: 'Opsional: apa yang salah dengan baris ini?',
    submit: 'Kirim',
    cancel: 'Batal',
    thanksConfirmation: 'Terima kasih, sudah ditandai',
    submitError: 'Gagal mengirim — coba lagi',
    disclaimer: 'Peringatan: Terjemahan mungkin mengandung kesalahan. Ini adalah demo langsung dari sistem terjemahan otomatis, dan teks terjemahan dihasilkan secara otomatis tanpa tinjauan manusia. Terjemahan mungkin sesekali tidak akurat, tidak lengkap, atau salah. Jika Anda melihat terjemahan yang tampak salah, silakan klik ikon bendera (⚑) di sebelah baris tersebut untuk melaporkannya — masukan Anda membantu kami meningkatkan sistem ini.',
  },
  tl: {
    flagPlaceholder: 'Opsyonal: ano ang mali sa linyang ito?',
    submit: 'Ipadala',
    cancel: 'Kanselahin',
    thanksConfirmation: 'Salamat, na-flag na',
    submitError: 'Hindi naipadala — subukan muli',
    disclaimer: 'Babala: Maaaring magkaroon ng mga pagkakamali ang mga pagsasalin. Ito ay isang live na demo ng isang automatic na sistema ng pagsasalin, at ang isinalin na teksto ay awtomatikong nabubuo nang walang pagsusuri ng tao. Maaaring paminsan-minsan itong hindi tumpak, hindi kumpleto, o mali ang pagkasalin. Kung mapansin mong may mali sa isang pagsasalin, mangyaring i-click ang icon ng bandila (⚑) sa tabi ng linyang iyon upang iulat ito — ang iyong feedback ay tumutulong sa amin na mapahusay ang sistema.',
  },
  ko: {
    flagPlaceholder: '선택 사항: 이 줄에 어떤 문제가 있나요?',
    submit: '제출',
    cancel: '취소',
    thanksConfirmation: '감사합니다, 신고되었습니다',
    submitError: '전송 실패 — 다시 시도해주세요',
    disclaimer: '경고: 번역에 오류가 포함될 수 있습니다. 이것은 자동 번역 시스템의 실시간 데모이며, 번역된 텍스트는 사람의 검토 없이 자동으로 생성됩니다. 때때로 부정확하거나 불완전하거나 잘못 번역될 수 있습니다. 잘못된 것 같은 번역을 발견하면 해당 줄 옆에 있는 깃발(⚑) 아이콘을 클릭하여 신고해 주세요. 여러분의 피드백은 시스템 개선에 도움이 됩니다.',
  },
  ja: {
    flagPlaceholder: '任意:この行の何が問題ですか?',
    submit: '送信',
    cancel: 'キャンセル',
    thanksConfirmation: 'ありがとうございます、報告されました',
    submitError: '送信できませんでした もう一度お試しください',
    disclaimer: '警告:翻訳には誤りが含まれる場合があります。これは自動翻訳システムのライブデモであり、翻訳されたテキストは人間によるレビューなしに自動生成されています。時々、不正確、不完全、または誤訳になることがあります。翻訳に誤りがあると思われる場合は、該当行の横にある旗(⚑)アイコンをクリックして報告してください。皆様のフィードバックはシステムの改善に役立ちます。',
  },
  vi: {
    flagPlaceholder: 'Không bắt buộc: dòng này có vấn đề gì?',
    submit: 'Gửi',
    cancel: 'Hủy',
    thanksConfirmation: 'Cảm ơn, đã được gắn cờ',
    submitError: 'Gửi không thành công — vui lòng thử lại',
    disclaimer: 'Cảnh báo: Bản dịch có thể chứa lỗi. Đây là bản demo trực tiếp của hệ thống dịch tự động, và văn bản dịch được tạo tự động mà không có sự xem xét của con người. Đôi khi bản dịch có thể không chính xác, không đầy đủ hoặc dịch sai. Nếu bạn nhận thấy một bản dịch có vẻ sai, vui lòng nhấp vào biểu tượng cờ (⚑) bên cạnh dòng đó để báo cáo — phản hồi của bạn giúp chúng tôi cải thiện hệ thống.',
  },
  th: {
    flagPlaceholder: 'ไม่บังคับ: บรรทัดนี้มีปัญหาอะไร?',
    submit: 'ส่ง',
    cancel: 'ยกเลิก',
    thanksConfirmation: 'ขอบคุณ ถูกทำเครื่องหมายแล้ว',
    submitError: 'ส่งไม่สำเร็จ — ลองอีกครั้ง',
    disclaimer: 'คำเตือน: คำแปลอาจมีข้อผิดพลาด นี่คือการสาธิตสดของระบบแปลภาษาอัตโนมัติ และข้อความที่แปลถูกสร้างขึ้นโดยอัตโนมัติโดยไม่มีการตรวจสอบจากมนุษย์ อาจไม่ถูกต้อง ไม่สมบูรณ์ หรือแปลผิดพลาดเป็นครั้งคราว หากคุณพบคำแปลที่ดูเหมือนจะผิด กรุณาคลิกไอคอนธง (⚑) ข้างบรรทัดนั้นเพื่อรายงาน — ความคิดเห็นของคุณช่วยให้เราปรับปรุงระบบให้ดีขึ้น',
  },
  es: {
    flagPlaceholder: 'Opcional: ¿qué está mal en esta línea?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Gracias, marcado',
    submitError: 'No se pudo enviar — inténtalo de nuevo',
    disclaimer: 'Advertencia: Las traducciones pueden contener errores. Esta es una demostración en vivo de un sistema de traducción automática, y el texto traducido se genera automáticamente sin revisión humana. Ocasionalmente puede ser inexacto, incompleto o estar mal traducido. Si notas una traducción que parece incorrecta, haz clic en el icono de la bandera (⚑) junto a esa línea para reportarla — tus comentarios nos ayudan a mejorar el sistema.',
  },
  pt: {
    flagPlaceholder: 'Opcional: o que está errado nesta linha?',
    submit: 'Enviar',
    cancel: 'Cancelar',
    thanksConfirmation: 'Obrigado, sinalizado',
    submitError: 'Falha ao enviar — tente novamente',
    disclaimer: 'Aviso: As traduções podem conter erros. Esta é uma demonstração ao vivo de um sistema de tradução automática, e o texto traduzido é gerado automaticamente sem revisão humana. Ocasionalmente, pode ser impreciso, incompleto ou mal traduzido. Se você notar uma tradução que pareça errada, clique no ícone da bandeira (⚑) ao lado dessa linha para reportá-la — seu feedback nos ajuda a melhorar o sistema.',
  },
  fr: {
    flagPlaceholder: "Facultatif : qu'est-ce qui ne va pas avec cette ligne ?",
    submit: 'Envoyer',
    cancel: 'Annuler',
    thanksConfirmation: 'Merci, signalé',
    submitError: "Échec de l'envoi — réessayez",
    disclaimer: "Avertissement : Les traductions peuvent contenir des erreurs. Il s'agit d'une démonstration en direct d'un système de traduction automatique, et le texte traduit est généré automatiquement sans révision humaine. Il peut parfois être inexact, incomplet ou mal traduit. Si vous remarquez une traduction qui semble incorrecte, veuillez cliquer sur l'icône du drapeau (⚑) à côté de cette ligne pour la signaler — vos commentaires nous aident à améliorer le système.",
  },
  hi: {
    flagPlaceholder: 'वैकल्पिक: इस पंक्ति में क्या गलत है?',
    submit: 'भेजें',
    cancel: 'रद्द करें',
    thanksConfirmation: 'धन्यवाद, फ़्लैग कर दिया गया',
    submitError: 'भेजने में विफल — पुनः प्रयास करें',
    disclaimer: 'चेतावनी: अनुवाद में त्रुटियां हो सकती हैं। यह एक स्वचालित अनुवाद प्रणाली का लाइव डेमो है, और अनूदित पाठ बिना किसी मानवीय समीक्षा के स्वचालित रूप से उत्पन्न होता है। यह कभी-कभी गलत, अधूरा या गलत अनुवादित हो सकता है। यदि आपको कोई अनुवाद गलत लगे, तो कृपया उस पंक्ति के बगल में फ़्लैग (⚑) आइकन पर क्लिक करके इसकी रिपोर्ट करें — आपकी प्रतिक्रिया हमें सिस्टम को बेहतर बनाने में मदद करती है।',
  },
  my: {
    flagPlaceholder: 'ချန်ထားနိုင်သည်: ဒီစာကြောင်းမှာ ဘာမှားနေလဲ?',
    submit: 'ပို့ရန်',
    cancel: 'ပယ်ဖျက်ရန်',
    thanksConfirmation: 'ကျေးဇူးတင်ပါသည်၊ အမှတ်အသားပြုပြီးပါပြီ',
    submitError: 'ပို့၍မရပါ — ထပ်စမ်းကြည့်ပါ',
    disclaimer: 'သတိပေးချက်: ဘာသာပြန်ချက်များတွင် အမှားများ ပါဝင်နိုင်ပါသည်။ ဤသည်မှာ အလိုအလျောက်ဘာသာပြန်စနစ်၏ တိုက်ရိုက်သရုပ်ပြမှုတစ်ခုဖြစ်ပြီး၊ ဘာသာပြန်ထားသော စာသားများကို လူ့ပြန်လည်စစ်ဆေးမှုမရှိဘဲ အလိုအလျောက်ထုတ်လုပ်ထားခြင်းဖြစ်သည်။ တစ်ခါတစ်ရံတွင် မတိကျခြင်း၊ မပြည့်စုံခြင်း သို့မဟုတ် ဘာသာပြန်မှားခြင်းများ ဖြစ်နိုင်ပါသည်။ ဘာသာပြန်ချက်တစ်ခု မှားယွင်းနေသည်ဟု သတိပြုမိပါက၊ ကျေးဇူးပြု၍ ထိုစာကြောင်းအနီးရှိ အလံ (⚑) သင်္ကေတကို နှိပ်ပြီး အစီရင်ခံပါ — သင်၏ တုံ့ပြန်ချက်သည် စနစ်ကို ပိုမိုကောင်းမွန်အောင် ကူညီပေးပါလိမ့်မည်။',
  },
};

export const EN_FALLBACK: FeedbackStrings = {
  flagPlaceholder: "Optional: what's wrong with this line?",
  submit: 'Submit',
  cancel: 'Cancel',
  thanksConfirmation: 'Thanks, flagged',
  submitError: "Couldn't send — try again",
  disclaimer: 'Warning: Translations may contain errors. This is a live demo of an automatic translation system, and the translated text is generated automatically without human review. It may occasionally be inaccurate, incomplete, or mistranslated. If you notice a translation that seems wrong, please click the flag (⚑) icon next to that line to report it — your feedback helps us improve the system.',
};

export function getFeedbackStrings(languageCode: string): FeedbackStrings {
  return FEEDBACK_STRINGS[languageCode] ?? EN_FALLBACK;
}
