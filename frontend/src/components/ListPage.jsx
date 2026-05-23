import Layout from './Layout'
import { SpinnerPage, ErrorMsg } from './ui'

// Shared shell for the top-level list/index pages: the Layout chrome, a
// scrollable padded content area, and the standard error + loading handling.
// `after` renders inside Layout but outside the scroll area (e.g. modals).
export default function ListPage({
  title,
  actions,
  isLoading,
  error,
  padding = '20px 24px',
  children,
  after,
}) {
  return (
    <Layout title={title} actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding }}>
        <ErrorMsg message={error} />
        {isLoading ? <SpinnerPage /> : children}
      </div>
      {after}
    </Layout>
  )
}
