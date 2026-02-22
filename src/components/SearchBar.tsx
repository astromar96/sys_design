import { useState, useMemo, useRef, useEffect } from 'react'
import type { Topic } from '../content'

interface Props {
  topics: Topic[]
  onNavigate: (topicId: string) => void
}

interface SearchResult {
  topicId: string
  topicTitle: string
  line: string
  lineIndex: number
}

export function SearchBar({ topics, onNavigate }: Props) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const results = useMemo<SearchResult[]>(() => {
    if (query.length < 2) return []
    const q = query.toLowerCase()
    const matches: SearchResult[] = []
    for (const topic of topics) {
      const lines = topic.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          matches.push({
            topicId: topic.id,
            topicTitle: topic.shortTitle,
            line: lines[i].replace(/^#+\s*/, '').slice(0, 120),
            lineIndex: i,
          })
          if (matches.length >= 20) return matches
        }
      }
    }
    return matches
  }, [query, topics])

  return (
    <div className="search-container" ref={ref}>
      <input
        type="text"
        className="search-input"
        placeholder="Search topics..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIsOpen(true)
        }}
        onFocus={() => setIsOpen(true)}
      />
      {isOpen && results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => (
            <li key={i}>
              <button
                className="search-result-item"
                onClick={() => {
                  onNavigate(r.topicId)
                  setIsOpen(false)
                  setQuery('')
                }}
              >
                <span className="search-result-topic">{r.topicTitle}</span>
                <span className="search-result-line">{r.line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
