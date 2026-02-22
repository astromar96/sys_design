import framework from '../content/00_system_design_framework.md?raw'
import urlShortener from '../content/01_url_shortener.md?raw'
import newsFeed from '../content/02_news_feed.md?raw'
import chatSystem from '../content/03_chat_system.md?raw'
import distributedCache from '../content/04_distributed_cache.md?raw'
import rideSharing from '../content/05_ride_sharing.md?raw'
import buildingBlocks from '../content/06_core_building_blocks.md?raw'

export interface Topic {
  id: string
  title: string
  shortTitle: string
  content: string
}

export const topics: Topic[] = [
  { id: 'framework', title: 'System Design Framework', shortTitle: 'Framework', content: framework },
  { id: 'url-shortener', title: 'URL Shortener', shortTitle: 'URL Shortener', content: urlShortener },
  { id: 'news-feed', title: 'News Feed', shortTitle: 'News Feed', content: newsFeed },
  { id: 'chat-system', title: 'Chat System', shortTitle: 'Chat System', content: chatSystem },
  { id: 'distributed-cache', title: 'Distributed Cache', shortTitle: 'Cache', content: distributedCache },
  { id: 'ride-sharing', title: 'Ride Sharing', shortTitle: 'Ride Sharing', content: rideSharing },
  { id: 'building-blocks', title: 'Core Building Blocks', shortTitle: 'Building Blocks', content: buildingBlocks },
]
