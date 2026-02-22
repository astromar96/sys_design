import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Components } from 'react-markdown'

interface Props {
  content: string
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

function makeHeading(Tag: 'h1' | 'h2' | 'h3' | 'h4') {
  return function Heading({ children }: { children?: React.ReactNode }) {
    const id = slugify(String(children))
    return <Tag id={id}>{children}</Tag>
  }
}

const components: Components = {
  h1: makeHeading('h1'),
  h2: makeHeading('h2'),
  h3: makeHeading('h3'),
  h4: makeHeading('h4'),
  code({ className, children, node, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const codeString = String(children).replace(/\n$/, '')
    const isBlock = node?.position && codeString.includes('\n')

    // Language-tagged code block → syntax highlight
    if (match) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          customStyle={{ borderRadius: '8px', fontSize: '0.85rem' }}
        >
          {codeString}
        </SyntaxHighlighter>
      )
    }

    // Multi-line block code → detect language or render as plain block
    if (isBlock) {
      // ASCII diagram detection
      if (/[┌┐└┘│─├┤┬┴┼╔╗╚╝║═╠╣╦╩╬┏┓┗┛┃━┣┫┳┻╋]/.test(codeString)) {
        return (
          <pre className="ascii-diagram">
            <code>{codeString}</code>
          </pre>
        )
      }

      // Auto-detect language for syntax highlighting
      let lang = 'text'
      if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/im.test(codeString)) {
        lang = 'sql'
      } else if (/^\s*(POST|GET|PUT|DELETE|PATCH)\s+\//.test(codeString)) {
        lang = 'http'
      } else if (/[{}]\s*$/.test(codeString) && /"[\w]+":\s/.test(codeString)) {
        lang = 'json'
      } else if (/^\s*(def |class |import |from |print\()/.test(codeString)) {
        lang = 'python'
      } else if (/^\s*(function |const |let |var |=>|import )/.test(codeString)) {
        lang = 'javascript'
      }

      return (
        <SyntaxHighlighter
          style={oneDark}
          language={lang}
          PreTag="div"
          customStyle={{ borderRadius: '8px', fontSize: '0.85rem' }}
        >
          {codeString}
        </SyntaxHighlighter>
      )
    }

    // Inline code
    return (
      <code className={`inline-code ${className || ''}`} {...props}>
        {children}
      </code>
    )
  },
}

export function MarkdownRenderer({ content }: Props) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
