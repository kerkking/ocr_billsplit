// Analytics utility for Google Analytics 4
export const analytics = {
  // Track custom events
  trackEvent: (eventName, parameters = {}) => {
    if (typeof window !== 'undefined' && window.gtag) {
      window.gtag('event', eventName, {
        // Add timestamp and page info automatically
        timestamp: new Date().toISOString(),
        page_location: window.location.href,
        page_title: document.title,
        ...parameters
      });
    }
  },

  // Track receipt uploads
  trackReceiptUpload: (fileSize, fileType) => {
    analytics.trackEvent('receipt_uploaded', {
      file_size_kb: Math.round(fileSize / 1024),
      file_type: fileType,
      event_category: 'engagement',
      event_label: 'receipt_processing'
    });
  },

  // Track auto-crop attempts
  trackAutoCrop: (success, confidence = null, error = null) => {
    analytics.trackEvent('auto_crop_attempt', {
      success: success,
      confidence: confidence,
      error_type: error,
      event_category: 'ml_processing',
      event_label: success ? 'auto_crop_success' : 'auto_crop_failed'
    });
  },

  // Track OCR processing
  trackOCR: (success, textLength = null, processingTime = null) => {
    analytics.trackEvent('ocr_processed', {
      success: success,
      text_length: textLength,
      processing_time_ms: processingTime,
      event_category: 'ocr_processing',
      event_label: success ? 'ocr_success' : 'ocr_failed'
    });
  },

  // Track LLM usage
  trackLLMCleanup: (success, tokensUsed = null, error = null) => {
    analytics.trackEvent('llm_cleanup', {
      success: success,
      tokens_used: tokensUsed,
      error_type: error,
      event_category: 'ai_processing',
      event_label: success ? 'llm_success' : 'llm_failed'
    });
  },

  // Track bill splitting completion
  trackBillSplit: (itemCount, dinerCount, totalAmount) => {
    analytics.trackEvent('bill_split_completed', {
      item_count: itemCount,
      diner_count: dinerCount,
      total_amount: totalAmount,
      event_category: 'engagement',
      event_label: 'bill_completed'
    });
  },

  // Track navigation between modes
  trackModeSwitch: (fromMode, toMode) => {
    analytics.trackEvent('mode_switch', {
      from_mode: fromMode,
      to_mode: toMode,
      event_category: 'navigation',
      event_label: `${fromMode}_to_${toMode}`
    });
  }
};