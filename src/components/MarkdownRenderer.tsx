import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Components } from 'react-markdown'

interface Props {
  content: string
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const codeString = String(children).replace(/\n$/, '')

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

    // Check if this looks like an ASCII diagram (multi-line with box chars)
    if (codeString.includes('\n') && /[┌┐└┘│─├┤┬┴┼╔╗╚╝║═╠╣╦╩╬┏┓┗┛┃━┣┫┳┻╋\+\-\|]/.test(codeString)) {
      return (
        <pre className="ascii-diagram">
          <code>{codeString}</code>
        </pre>
      )
    }

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
