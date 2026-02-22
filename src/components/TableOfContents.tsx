import { useMemo } from 'react'

interface Heading {
  level: number
  text: string
  id: string
}

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

export function TableOfContents({ content }: Props) {
  const headings = useMemo<Heading[]>(() => {
    const lines = content.split('\n')
    const result: Heading[] = []
    for (const line of lines) {
      const match = line.match(/^(#{2,3})\s+(.+)/)
      if (match) {
        result.push({
          level: match[1].length,
          text: match[2].replace(/[*_`]/g, ''),
          id: slugify(match[2]),
        })
      }
    }
    return result
  }, [content])

  if (headings.length === 0) return null

  return (
    <aside className="toc">
      <h3>On This Page</h3>
      <ul>
        {headings.map((h, i) => (
          <li key={i} className={`toc-item toc-level-${h.level}`}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault()
                const el = document.getElementById(h.id)
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}
