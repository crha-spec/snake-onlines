// render-start.js
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Render-specific optimizations
process.env.UV_THREADPOOL_SIZE = 128;
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Memory optimization for Render
process.env.NODE_OPTIONS = '--max-old-space-size=4096 --max-http-header-size=16384';

// Graceful shutdown handler
const gracefulShutdown = (signal) => {
  console.log(`🛑 ${signal} received, shutting down gracefully...`);
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For nodemon

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('💥 UNCAUGHT EXCEPTION:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the main server
console.log('🚀 Starting Video Oyun Platformu on Render...');
console.log('📊 Environment:', process.env.NODE_ENV);
console.log('🔧 Node Options:', process.env.NODE_OPTIONS);

const server = spawn('node', ['server.js'], {
  stdio: 'inherit',
  env: process.env
});

server.on('close', (code) => {
  console.log(`🚀 Server process exited with code ${code}`);
  process.exit(code);
});

server.on('error', (error) => {
  console.error('💥 Server startup error:', error);
  process.exit(1);
});
