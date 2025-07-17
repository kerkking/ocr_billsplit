import React from "react";
import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import ImageCropper from './ImageCropper';

function Home() {
  return (
    <main className="container">
      <section style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <h1>Bill Splitter</h1>
        <p>Split bills easily by uploading receipts or manual entry. Minimal, fast, and private.</p>
        <nav style={{ margin: '2rem 0', display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', maxWidth: 320 }}>
          <Link to="/manual" role="button">Manual Mode</Link>
          <Link to="/ocr" role="button" className="neon-pink">Upload Receipt</Link>
        </nav>
      </section>
    </main>
  );
}

function renderSimpleSummary(diners, results) {
  return (
    <table>
      <thead>
        <tr>
          <th>Diner</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {diners.map((diner, idx) => (
          <tr key={idx}>
            <td>{diner || `Diner #${idx + 1}`}</td>
            <td>${results[idx].toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderDetailedSummary(diners, items, taxMultiplier, gstPercent) {
  // Calculate per-diner, per-item shares
  const dinerItemShares = diners.map(() => Array(items.length).fill(0));
  const itemBases = items.map(item => parseFloat(item.price || 0));
  // Fill dinerItemShares (base only)
  items.forEach((item, itemIdx) => {
    if (item.sharedBy.length > 0) {
      const share = itemBases[itemIdx] / item.sharedBy.length;
      item.sharedBy.forEach(dinerIdx => {
        dinerItemShares[dinerIdx][itemIdx] = share;
      });
    }
  });
  // Subtotal per diner
  const subtotals = dinerItemShares.map(row => row.reduce((a, b) => a + b, 0));
  // Service charge per diner
  const serviceCharges = subtotals.map(st => st * (taxMultiplier - 1));
  // GST per diner (applied after service charge)
  const gstCharges = subtotals.map((st, i) => (st + serviceCharges[i]) * (gstPercent / 100));
  // Grand total per diner
  const grandTotals = subtotals.map((st, i) => st + serviceCharges[i] + gstCharges[i]);

  return (
    <table>
      <thead>
        <tr>
          <th style={{ minWidth: 80 }}>Item</th>
          {diners.map((diner, idx) => (
            <th key={idx} style={{ minWidth: 80 }}>{diner || `Diner #${idx + 1}`}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item, itemIdx) => (
          <tr key={itemIdx}>
            <td style={{ minWidth: 80 }}>{item.name || `Item #${itemIdx + 1}`}</td>
            {diners.map((_, dIdx) => (
              <td key={dIdx} style={{ minWidth: 80 }}>{dinerItemShares[dIdx][itemIdx] ? dinerItemShares[dIdx][itemIdx].toFixed(2) : ''}</td>
            ))}
          </tr>
        ))}
        <tr>
          <td style={{ minWidth: 80 }}><b>subtotal</b></td>
          {subtotals.map((st, i) => <td key={i} style={{ minWidth: 80 }}>{st ? st.toFixed(2) : ''}</td>)}
        </tr>
        <tr>
          <td style={{ minWidth: 80 }}>{((taxMultiplier - 1) * 100).toFixed(0)}% service charge</td>
          {serviceCharges.map((sc, i) => <td key={i} style={{ minWidth: 80 }}>{sc ? sc.toFixed(2) : ''}</td>)}
        </tr>
        <tr>
          <td style={{ minWidth: 80 }}>{gstPercent}% GST</td>
          {gstCharges.map((gst, i) => <td key={i} style={{ minWidth: 80 }}>{gst ? gst.toFixed(4) : ''}</td>)}
        </tr>
        <tr>
          <td style={{ minWidth: 80 }}><b>total</b></td>
          {grandTotals.map((gt, i) => <td key={i} style={{ minWidth: 80 }}><b>{gt ? gt.toFixed(4) : ''}</b></td>)}
        </tr>
      </tbody>
    </table>
  );
}

function tableToText(tableElem) {
  // Convert a rendered table element to plain text for copying
  if (!tableElem) return '';
  const rows = Array.from(tableElem.querySelectorAll('tr'));
  return rows.map(row =>
    Array.from(row.children).map(cell => cell.textContent.trim()).join('\t')
  ).join('\n');
}

// --- ManualMode ---
function ManualMode() {
  const [diners, setDiners] = React.useState([""]);
  const [items, setItems] = React.useState([
    { name: "", price: "", sharedBy: [] }
  ]);
  const [taxMultiplier, setTaxMultiplier] = React.useState(1.1);
  const [gstPercent, setGstPercent] = React.useState(9);
  const [showDetailed, setShowDetailed] = React.useState(false);
  const tableRef = React.useRef();

  // Add/remove diners
  const handleDinerChange = (idx, value) => {
    const newDiners = [...diners];
    newDiners[idx] = value;
    setDiners(newDiners);
  };
  const addDiner = () => setDiners([...diners, ""]);
  const removeDiner = idx => setDiners(diners.filter((_, i) => i !== idx));

  // Add/remove items
  const handleItemChange = (idx, field, value) => {
    const newItems = [...items];
    newItems[idx][field] = value;
    setItems(newItems);
  };
  const handleItemDinerToggle = (itemIdx, dinerIdx) => {
    const newItems = [...items];
    const shared = newItems[itemIdx].sharedBy;
    if (shared.includes(dinerIdx)) {
      newItems[itemIdx].sharedBy = shared.filter(i => i !== dinerIdx);
    } else {
      newItems[itemIdx].sharedBy = [...shared, dinerIdx];
    }
    setItems(newItems);
  };
  const addItem = () => setItems([...items, { name: "", price: "", sharedBy: [] }]);
  const removeItem = idx => setItems(items.filter((_, i) => i !== idx));

  // Calculate results
  const results = React.useMemo(() => {
    const dinerTotals = Array(diners.length).fill(0);
    items.forEach(item => {
      const base = parseFloat(item.price || 0);
      const serviceCharge = base * (taxMultiplier - 1);
      const subtotal = base + serviceCharge;
      const gst = subtotal * (gstPercent / 100);
      const total = subtotal + gst;
      if (item.sharedBy.length > 0) {
        const share = total / item.sharedBy.length;
        item.sharedBy.forEach(idx => {
          dinerTotals[idx] += share;
        });
      }
    });
    return dinerTotals;
  }, [diners, items, taxMultiplier, gstPercent]);

  return (
    <main className="container">
      <h2>Manual Bill Splitter</h2>
      <form>
        <fieldset>
          <legend>Diners</legend>
          {diners.map((diner, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input
                value={diner}
                onChange={e => handleDinerChange(idx, e.target.value)}
                placeholder={`Diner #${idx + 1}`}
                style={{ width: '100%', maxWidth: 180 }}
              />
              {diners.length > 1 && (
                <button type="button" onClick={() => removeDiner(idx)} aria-label="Remove diner">&times;</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addDiner}>Add Diner</button>
        </fieldset>
        <fieldset>
          <legend>Bill Items</legend>
          {items.map((item, idx) => (
            <div key={idx} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input
                value={item.name}
                onChange={e => handleItemChange(idx, "name", e.target.value)}
                placeholder="Item name"
                style={{ width: '100%', maxWidth: 180 }}
              />
              <input
                type="number"
                min="0"
                value={item.price}
                onChange={e => handleItemChange(idx, "price", e.target.value)}
                placeholder="Price"
                style={{ width: '100%', maxWidth: 110, marginLeft: 8 }}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {diners.map((diner, dIdx) => (
                  <label key={dIdx} style={{ fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={item.sharedBy.includes(dIdx)}
                      onChange={() => handleItemDinerToggle(idx, dIdx)}
                    />
                    {diner || `Diner #${dIdx + 1}`}
                  </label>
                ))}
              </div>
              {items.length > 1 && (
                <button type="button" onClick={() => removeItem(idx)} aria-label="Remove item">&times;</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addItem}>Add Item</button>
        </fieldset>
        <fieldset>
          <label>
            Service Tax Multiplier:
            <input
              type="number"
              min="1"
              step="0.01"
              value={taxMultiplier}
              onChange={e => setTaxMultiplier(parseFloat(e.target.value) || 1)}
              style={{ width: '100%', maxWidth: 110, marginLeft: 8 }}
            />
            <span style={{ fontSize: 12, marginLeft: 8 }}>(e.g. 1.1 for 10% service charge)</span>
          </label>
        </fieldset>
        <fieldset>
          <label>
            GST (%):
            <input
              type="number"
              min="0"
              step="0.01"
              value={gstPercent}
              onChange={e => setGstPercent(parseFloat(e.target.value) || 0)}
              style={{ width: '100%', maxWidth: 110, marginLeft: 8 }}
            />
            <span style={{ fontSize: 12, marginLeft: 8 }}>(e.g. 9 for 9% GST)</span>
          </label>
        </fieldset>
      </form>
      <section>
        <h3>Result</h3>
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <button type="button" onClick={() => setShowDetailed(d => !d)}>
            {showDetailed ? 'Show Simple Summary' : 'Show Detailed Summary'}
          </button>
          <button type="button" onClick={() => {
            if (tableRef.current) {
              const text = tableToText(tableRef.current);
              navigator.clipboard.writeText(text);
            }
          }}>Copy Summary</button>
        </div>
        <div style={{ overflowX: 'auto' }} ref={tableRef}>
          {showDetailed
            ? renderDetailedSummary(diners, items, taxMultiplier, gstPercent)
            : renderSimpleSummary(diners, results)}
        </div>
      </section>
    </main>
  );
}

function OCRMode() {
  const [showCropper, setShowCropper] = React.useState(true);
  const [croppedImage, setCroppedImage] = React.useState(null);
  const [ocrText, setOcrText] = React.useState("");
  const [ocrLoading, setOcrLoading] = React.useState(false);
  const [llmText, setLlmText] = React.useState("");
  const [llmLoading, setLlmLoading] = React.useState(false);
  const [llmError, setLlmError] = React.useState("");
  const [showBillForm, setShowBillForm] = React.useState(false);
  const [diners, setDiners] = React.useState([""]);
  const [items, setItems] = React.useState([{ name: "", price: "", sharedBy: [] }]);
  const [taxMultiplier, setTaxMultiplier] = React.useState(1.1);
  const [gstPercent, setGstPercent] = React.useState(9);
  const [showDetailed, setShowDetailed] = React.useState(false);
  const tableRef = React.useRef();

  // Run OCR when croppedImage changes
  React.useEffect(() => {
    if (!croppedImage) return;
    setOcrLoading(true);
    setOcrText("");
    setLlmText("");
    setLlmError("");
    setShowBillForm(false);
    (async () => {
      const Tesseract = await import('tesseract.js');
      Tesseract.recognize(
        croppedImage,
        'eng',
        { logger: m => {/* Optionally log progress */} }
      ).then(({ data: { text } }) => {
        setOcrText(text);
        setOcrLoading(false);
      }).catch(() => {
        setOcrText("OCR failed. Please try again.");
        setOcrLoading(false);
      });
    })();
  }, [croppedImage]);

  // LLM cleanup
  const handleLLMCleanup = async () => {
    setLlmLoading(true);
    setLlmError("");
    setLlmText("");
    setShowBillForm(false);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${import.meta.env.nothinghere}`
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are a helpful assistant that extracts and cleans up bill items from OCR text. Return only the cleaned, itemized bill as a table with the headers: name, quantity, price. Each row should correspond to one item. If quantity is missing, use 1. Price should be a number only, no currency symbol." },
            { role: "user", content: ocrText }
          ],
          temperature: 0.2
        })
      });
      const data = await response.json();
      if (data.choices && data.choices[0] && data.choices[0].message) {
        setLlmText(data.choices[0].message.content);
        // Try to parse the LLM output into bill items
        const lines = data.choices[0].message.content.split('\n').filter(l => l.trim());
        // Find header row and start parsing from the next line
        let headerIdx = lines.findIndex(line => /name/i.test(line) && /price/i.test(line));
        let parsedItems = [];
        if (headerIdx !== -1) {
          for (let i = headerIdx + 1; i < lines.length; i++) {
            const row = lines[i].trim();
            if (!row) continue;
            // Split by | or whitespace
            let cols = row.split('|').map(s => s.trim()).filter(Boolean);
            if (cols.length < 3) {
              cols = row.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
            }
            if (cols.length >= 3) {
              parsedItems.push({
                name: cols[0],
                quantity: cols[1],
                price: cols[2],
                sharedBy: []
              });
            }
          }
        }
        if (!parsedItems.length) {
          // fallback: try previous regex
          parsedItems = lines.map(line => {
            const match = line.match(/^(.*?)(?:\s+x(\d+))?\s+([\d.]+)$/);
            if (match) {
              return {
                name: match[1].trim(),
                price: match[3],
                sharedBy: []
              };
            } else {
              return { name: line, price: '', sharedBy: [] };
            }
          });
        }
        setItems(parsedItems.length ? parsedItems : [{ name: "", price: "", sharedBy: [] }]);
        setShowBillForm(true);
      } else if (data.error) {
        setLlmError("OpenAI error: " + (data.error.message || JSON.stringify(data.error)));
      } else {
        setLlmError("No response from LLM. Raw response: " + JSON.stringify(data));
      }
    } catch (err) {
      setLlmError("Failed to call OpenAI: " + err.message);
    }
    setLlmLoading(false);
  };

  // Manual Mode calculation logic
  const results = React.useMemo(() => {
    const dinerTotals = Array(diners.length).fill(0);
    items.forEach(item => {
      const base = parseFloat(item.price || 0);
      const serviceCharge = base * (taxMultiplier - 1);
      const subtotal = base + serviceCharge;
      const gst = subtotal * (gstPercent / 100);
      const total = subtotal + gst;
      if (item.sharedBy.length > 0) {
        const share = total / item.sharedBy.length;
        item.sharedBy.forEach(idx => {
          dinerTotals[idx] += share;
        });
      }
    });
    return dinerTotals;
  }, [diners, items, taxMultiplier, gstPercent]);

  // Diners and items form handlers (copied from ManualMode)
  const handleDinerChange = (idx, value) => {
    const newDiners = [...diners];
    newDiners[idx] = value;
    setDiners(newDiners);
  };
  const addDiner = () => setDiners([...diners, ""]);
  const removeDiner = idx => setDiners(diners.filter((_, i) => i !== idx));
  const handleItemChange = (idx, field, value) => {
    const newItems = [...items];
    newItems[idx][field] = value;
    setItems(newItems);
  };
  const handleItemDinerToggle = (itemIdx, dinerIdx) => {
    const newItems = [...items];
    const shared = newItems[itemIdx].sharedBy;
    if (shared.includes(dinerIdx)) {
      newItems[itemIdx].sharedBy = shared.filter(i => i !== dinerIdx);
    } else {
      newItems[itemIdx].sharedBy = [...shared, dinerIdx];
    }
    setItems(newItems);
  };
  const addItem = () => setItems([...items, { name: "", price: "", sharedBy: [] }]);
  const removeItem = idx => setItems(items.filter((_, i) => i !== idx));

  // New: handleCrop function
  const handleCrop = (croppedImg) => {
    setCroppedImage(croppedImg);
    setShowCropper(false);
  };

  return (
    <main className="container">
      <h2>OCR Bill Splitter</h2>
      <section>
        <h3>1. Crop Image</h3>
        {showCropper && (
          <ImageCropper onCrop={handleCrop} />
        )}
        {croppedImage && !showCropper && (
          <div style={{ marginTop: 16 }}>
            <h4>Cropped Image Preview</h4>
            <img src={croppedImage} alt="Cropped" style={{ maxWidth: '100%', maxHeight: 400, border: '1px solid #ccc' }} />
            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={() => { setShowCropper(true); setCroppedImage(null); }}>Crop Another</button>
            </div>
          </div>
        )}
      </section>
      {croppedImage && (
        <section style={{ marginTop: 32 }}>
          <h3>2. OCR Result</h3>
          {ocrLoading ? (
            <p>Processing OCR...</p>
          ) : (
            <>
              <pre style={{ background: '#f6f6f6', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{ocrText}</pre>
              <button type="button" onClick={handleLLMCleanup} disabled={llmLoading || !ocrText}>
                {llmLoading ? "Cleaning up..." : "Clean Up with LLM"}
              </button>
              {llmError && <p style={{ color: 'red' }}>{llmError}</p>}
              {llmText && (
                <div style={{ marginTop: 24 }}>
                  <h4>LLM Cleaned Bill Items</h4>
                  <pre style={{ background: '#f6f6f6', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{llmText}</pre>
                  {showBillForm && (
                    <form style={{ marginTop: 24 }}>
                      <fieldset>
                        <legend>Diners</legend>
                        {diners.map((diner, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            <input
                              value={diner}
                              onChange={e => handleDinerChange(idx, e.target.value)}
                              placeholder={`Diner #${idx + 1}`}
                              style={{ width: '100%', maxWidth: 180 }}
                            />
                            {diners.length > 1 && (
                              <button type="button" onClick={() => removeDiner(idx)} aria-label="Remove diner">&times;</button>
                            )}
                          </div>
                        ))}
                        <button type="button" onClick={addDiner}>Add Diner</button>
                      </fieldset>
                      <fieldset>
                        <legend>Bill Items</legend>
                        {items.map((item, idx) => (
                          <div key={idx} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            <input
                              value={item.name}
                              onChange={e => handleItemChange(idx, "name", e.target.value)}
                              placeholder="Item name"
                              style={{ width: '100%', maxWidth: 180 }}
                            />
                            <input
                              type="number"
                              min="0"
                              value={item.price}
                              onChange={e => handleItemChange(idx, "price", e.target.value)}
                              placeholder="Price"
                              style={{ width: '100%', maxWidth: 110, marginLeft: 8 }}
                            />
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {diners.map((diner, dIdx) => (
                                <label key={dIdx} style={{ fontSize: 12 }}>
                                  <input
                                    type="checkbox"
                                    checked={item.sharedBy.includes(dIdx)}
                                    onChange={() => handleItemDinerToggle(idx, dIdx)}
                                  />
                                  {diner || `Diner #${dIdx + 1}`}
                                </label>
                              ))}
                            </div>
                            {items.length > 1 && (
                              <button type="button" onClick={() => removeItem(idx)} aria-label="Remove item">&times;</button>
                            )}
                          </div>
                        ))}
                        <button type="button" onClick={addItem}>Add Item</button>
                      </fieldset>
                      <fieldset>
                        <label>
                          Service Tax Multiplier:
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            value={taxMultiplier}
                            onChange={e => setTaxMultiplier(parseFloat(e.target.value) || 1)}
                            style={{ width: '100%', maxWidth: 110, marginLeft: 8 }}
                          />
                          <span style={{ fontSize: 12, marginLeft: 8 }}>(e.g. 1.1 for 10% service charge)</span>
                        </label>
                      </fieldset>
                      <fieldset>
                        <label>
                          GST (%):
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={gstPercent}
                            onChange={e => setGstPercent(parseFloat(e.target.value) || 0)}
                            style={{ width: '100%', maxWidth: 110, marginLeft: 8 }}
                          />
                          <span style={{ fontSize: 12, marginLeft: 8 }}>(e.g. 9 for 9% GST)</span>
                        </label>
                      </fieldset>
                    </form>
                  )}
                  {showBillForm && (
                    <section style={{ marginTop: 24 }}>
                      <h4>Result</h4>
                      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                        <button type="button" onClick={() => setShowDetailed(d => !d)}>
                          {showDetailed ? 'Show Simple Summary' : 'Show Detailed Summary'}
                        </button>
                        <button type="button" onClick={() => {
                          if (tableRef.current) {
                            const text = tableToText(tableRef.current);
                            navigator.clipboard.writeText(text);
                          }
                        }}>Copy Summary</button>
                      </div>
                      <div style={{ overflowX: 'auto' }} ref={tableRef}>
                        {showDetailed
                          ? renderDetailedSummary(diners, items, taxMultiplier, gstPercent)
                          : renderSimpleSummary(diners, results)}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}

export default function App() {
  return (
    <Router>
      <nav className="container" style={{ marginTop: 16, marginBottom: 32 }}>
        <ul style={{ display: 'flex', gap: 16, listStyle: 'none', padding: 0, justifyContent: 'center' }}>
          <li><Link to="/">Home</Link></li>
          <li><Link to="/ocr">OCR Mode</Link></li>
          <li><Link to="/manual">Manual Mode</Link></li>
        </ul>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/ocr" element={<OCRMode />} />
        <Route path="/manual" element={<ManualMode />} />
        <Route path="/cropper-test" element={<ImageCropper />} />
      </Routes>
    </Router>
  );
}
