// Helper: Log messages with timestamp.
export default (...messages: any[]): void => {
  console.log(`[${new Date().toISOString()}]`, ...messages);
};
