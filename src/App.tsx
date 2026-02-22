import { useState, useEffect, useCallback } from 'react'
import { topics } from './content'
import { useTheme } from './hooks/useTheme'
import { Sidebar } from './components/Sidebar'
import { MarkdownRenderer } from './components/MarkdownRenderer'
import { TableOfContents } from './components/TableOfContents'
import { SearchBar } from './components/SearchBar'
import { ThemeToggle } from './components/ThemeToggle'

function getTopicFromHash(): string {
  const hash = window.location.hash.replace('#', '')
  if (hash && topics.find((t) => t.id === hash)) return hash
  return topics[0].id
}

export default function App() {
  const { theme, toggleTheme } = useTheme()
  const [activeId, setActiveId] = useState(getTopicFromHash)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const activeTopic = topics.find((t) => t.id === activeId) || topics[0]

  const navigate = useCallback((id: string) => {
    setActiveId(id)
    window.location.hash = id
    window.scrollTo({ top: 0 })
  }, [])

  useEffect(() => {
    const onHash = () => setActiveId(getTopicFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <h1 className="topbar-title">System Design Study Guide</h1>
        <SearchBar topics={topics} onNavigate={navigate} />
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      <div className="layout">
        <Sidebar
          topics={topics}
          activeId={activeId}
          onSelect={navigate}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        <main className="content">
          <MarkdownRenderer content={activeTopic.content} />
        </main>

        <TableOfContents content={activeTopic.content} />
      </div>
    </div>
  )
}
