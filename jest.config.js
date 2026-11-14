export default {
  testEnvironment: "node",
  transform: {},
  testMatch: ["**/__tests__/**/*.test.js"],
  setupFiles: ["<rootDir>/__tests__/helpers/env.js"],
  testTimeout: 30000,
  verbose: true,
};
