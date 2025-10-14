import { useParams, Link } from "react-router-dom"
import machines from "../data/machines.json"

export default function CategoryList() {
  const { name } = useParams()
  const list = machines.filter(m => m.category === name)

  return (
    <div className="container">
      <Link to="/" className="link">← Back to Categories</Link>
      <h2 style={{margin:'12px 0'}}>{name}</h2>
      <div className="grid">
        {list.map(m => (
          <div key={m.id} className="card">
            <div className="thumb" style={{backgroundImage:`url(${m.image||''})`}} />
            <div style={{marginTop:8,fontWeight:700}}>{m.name}</div>
            <div className="badge">{m.category}</div>
            <div style={{fontSize:13,marginTop:4}}>{m.specs}</div>
            <div className="price">MRP: ₹{m.mrp.toLocaleString('en-IN')}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
