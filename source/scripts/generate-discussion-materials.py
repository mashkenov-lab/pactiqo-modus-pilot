import json, pathlib, subprocess, hashlib, shutil
from xml.sax.saxutils import escape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from pypdf import PdfReader

root=pathlib.Path(__file__).resolve().parents[1]
out=root/'fixtures/discussion-materials';out.mkdir(exist_ok=True)
tmp=root/'.superpowers/sdd/2026-11-13-modus-files/pdf-preview';tmp.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('Arial','C:/Windows/Fonts/arial.ttf'))
pdfmetrics.registerFont(TTFont('ArialBold','C:/Windows/Fonts/arialbd.ttf'))
body=ParagraphStyle('body',fontName='Arial',fontSize=10,leading=15,textColor=colors.HexColor('#243e55'),spaceAfter=12)
title=ParagraphStyle('title',parent=body,fontName='ArialBold',fontSize=23,leading=28,spaceAfter=18)
heading=ParagraphStyle('heading',parent=body,fontName='ArialBold',fontSize=13,leading=18,spaceBefore=12)
small=ParagraphStyle('small',parent=body,fontSize=8,leading=12,textColor=colors.HexColor('#61748a'))
def p(s,style=body):return Paragraph(escape(s),style)
def frame(c,doc):
 c.setFillColor(colors.HexColor('#17324f'));c.rect(0,794,A4[0],48,fill=1,stroke=0)
 c.setFillColor(colors.white);c.setFont('ArialBold',13);c.drawString(40,812,'PACTIQO  /  MODUS')
 c.setFont('Arial',8);c.drawRightString(555,812,'УЧЕБНЫЙ МАТЕРИАЛ')
 c.setFillColor(colors.HexColor('#61748a'));c.setFont('Arial',8);c.drawString(40,25,'Синтетический пример. Не документ компании и не подтверждение внедрения.')
 c.drawRightString(555,25,str(doc.page))
def build(s,record,version,dest):
 label='Исходный пример для обсуждения' if version==0 else ('Проект документа / версия 1' if version==1 else 'Исправленный проект / версия 2')
 story=[p(s['reference']+'  ·  '+label,small),p(s['title'],title),p('Ситуация',heading),p(record['description'])]
 data=[[p(x,small) for x in s['columns']]]+[[p(x) for x in row] for row in s['rows']]
 table=Table(data,colWidths=[150,180,185],hAlign='LEFT');table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e5edf7')),('VALIGN',(0,0),(-1,-1),'TOP'),('GRID',(0,0),(-1,-1),.5,colors.HexColor('#cbd7e4')),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
 story += [Spacer(1,8),table,p('Предмет обсуждения' if version<2 else 'Изменение после замечания',heading),p(s['remark'] if version<2 else s['correction'])]
 if version==2:story += [PageBreak(),p(s['reference']+'  ·  Версия 2 / проверка',small),p('Как проверим результат',title),p(s['result']),p('Порядок согласования',heading),p('1. Автор открывает конкретный файл и проверяет содержание.'),p('2. Замечание или согласование сохраняется в обсуждении с именем участника и временем.'),p('3. Новая редакция загружается отдельным файлом. Предыдущая остаётся в истории.'),p('Граница решения',heading),p('Согласование материала не закрывает обращение. Исполнение и приёмка результата оформляются отдельными действиями в карточке.'),p('Изменение этой редакции',heading),p(s['correction'])]
 SimpleDocTemplate(str(dest),pagesize=A4,rightMargin=40,leftMargin=40,topMargin=72,bottomMargin=50,title=s['title'],author='PACTIQO · учебные материалы').build(story,onFirstPage=frame,onLaterPages=frame)
 reader=PdfReader(dest);assert len(reader.pages)==(2 if version==2 else 1),(s['reference'],version,len(reader.pages));assert s['reference'] in reader.pages[0].extract_text()
records={r['reference']:r for r in json.loads((root/'fixtures/modus-dataset.json').read_text(encoding='utf-8'))['records']}
manifest=[];poppler=shutil.which('pdftoppm')
assert poppler
for s in json.loads((root/'fixtures/discussion-scenarios.json').read_text(encoding='utf-8')):
 files=[]
 for version in (0,1,2):
  name=f"{s['reference']}-{'example' if version==0 else 'v'+str(version)}"
  target=(tmp if version==0 else out)/(name+'.pdf');build(s,records[s['reference']],version,target)
  if version==0:
   subprocess.run([poppler,'-f','1','-singlefile','-scale-to','1200','-png',str(target),str(out/name)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);target=out/(name+'.png')
  data=target.read_bytes();files.append({'file':target.name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 manifest.append({'reference':s['reference'],'files':files})
(out/'manifest.json').write_text(json.dumps({'synthetic':True,'records':manifest},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'cases':len(manifest),'files':sum(len(x['files']) for x in manifest),'pdf':40,'images':20}))
