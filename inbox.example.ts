import { defineConfig } from './config/schema';

export default defineConfig({
  region: 'us-east-1',
  alertEmail: 'operator@example.com',
  stages: {
    prod: { domains: ['in.example.com'], removalPolicy: 'retain' },
    e2e: { domains: ['test.example.com'], removalPolicy: 'destroy' },
  },
});
