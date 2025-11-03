// cleanup.js - Opsiyonel temizlik script'i
import { writeFileSync } from 'fs';

console.log('🧹 Starting cleanup process...');

// Burada gerekiyorsa temizlik işlemleri yapılabilir
// Örneğin: log dosyalarını temizleme, geçici dosyaları silme

const cleanupReport = {
  timestamp: new Date().toISOString(),
  status: 'completed',
  message: 'Cleanup process finished successfully'
};

writeFileSync('/tmp/cleanup-report.json', JSON.stringify(cleanupReport, null, 2));
console.log('✅ Cleanup completed:', cleanupReport);
