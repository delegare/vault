export class McpServer {
  tools: any[] = [];
  widgets: any[] = [];
  
  constructor(options: any) {}

  tool(name: string, description: any, schema: any, handler: any) {
    this.tools.push({ name, description, schema, handler });
  }

  registerWidget(name: string, description: any, schema: any, handler: any) {
    this.widgets.push({ name, description, schema, handler });
  }

  async connect(transport: any) {
    return Promise.resolve();
  }
}
