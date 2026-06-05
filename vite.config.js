import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      ignored: [
        '**/downloads/**',
        '**/chrome-temp-profile/**',
        '**/.git/**',
        '**/.partykit/**',
        '**/.vercel/**',
        '**/*.log'
      ]
    }
  }
});
