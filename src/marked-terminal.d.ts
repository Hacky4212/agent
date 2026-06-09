declare module 'marked-terminal' {
  import { type MarkedExtension } from 'marked';

  interface TerminalRendererOptions {
    code?: (code: string, lang: string) => string;
    codespan?: (text: string) => string;
    heading?: (text: string, level: number) => string;
    strong?: (text: string) => string;
    em?: (text: string) => string;
    link?: (href: string, title: string, text: string) => string;
    hr?: () => string;
    blockquote?: (text: string) => string;
    list?: (body: string, ordered: boolean) => string;
    listitem?: (text: string) => string;
    paragraph?: (text: string) => string;
    [key: string]: unknown;
  }

  export default class TerminalRenderer implements MarkedExtension {
    constructor(options?: TerminalRendererOptions);
  }
}
