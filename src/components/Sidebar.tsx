import type { Topic } from '../content'

interface Props {
  topics: Topic[]
  activeId: string
  onSelect: (id: string) => void
  isOpen: boolean
  onClose: () => void
}

export function Sidebar({ topics, activeId, onSelect, isOpen, onClose }: Props) {
  return (
    <>
      {isOpen && <div className="sidebar-overlay" onClick={onClose} />}
      <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
        <nav>
          <div className="sidebar-header">
            <h2>Topics</h2>
            <button className="sidebar-close" onClick={onClose} aria-label="Close menu">
              &times;
            </button>
          </div>
          <ul>
            {topics.map((topic, i) => (
              <li key={topic.id}>
                <button
                  className={`sidebar-item ${activeId === topic.id ? 'active' : ''}`}
                  onClick={() => {
                    onSelect(topic.id)
                    onClose()
                  }}
                >
                  <span className="sidebar-num">{String(i).padStart(2, '0')}</span>
                  <span className="sidebar-title">{topic.shortTitle}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  )
}
