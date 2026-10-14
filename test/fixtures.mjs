import { once } from 'node:events';
export const confirmedModels = async()=>({success:true,result:{records:[{aiType:'qwen-instruct',rootAiType:'xinference'}]}});

// Let the OS avoid reserved/excluded Windows port ranges. Manually selecting a
// random port can fail with EACCES when Hyper-V has reserved that port.
export async function listenForFetch(server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
}

export function simplePdf(text='Hello PDF'){
  const escaped=text.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\nendstream`
  ];
  let source='%PDF-1.4\n',offsets=[0];
  objects.forEach((body,index)=>{offsets.push(Buffer.byteLength(source));source+=`${index+1} 0 obj\n${body}\nendobj\n`;});
  const xref=Buffer.byteLength(source);source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
