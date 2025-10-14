import { Link } from "react-router-dom"
import machines from "../data/machines.json"

export default function Home() {
  // Extract unique categories
  const categories = [...new Set(machines.map(m => m.category))]

  return (
    <div className="container">
      <h2 style={{textAlign:'center', marginBottom:20}}>HVF Machinery Catalog</h2>
      <div className="grid cols">
        {categories.map(cat => (
          <Link key={cat} to={`/category/${encodeURIComponent(cat)}`}>
            <div className="card" style={{textAlign:'center', cursor:'pointer'}}>
              <div className="thumb" style={{background:'#f1f1f1'}} />
              <div style={{marginTop:8, fontWeight:600}}>{cat}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
