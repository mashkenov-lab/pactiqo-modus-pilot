const defaults=[{id:'whatsapp',name:'WhatsApp',url:'https://web.whatsapp.com/',color:'#25d366'},{id:'telegram',name:'Telegram',url:'https://web.telegram.org/',color:'#3ba9ec'},{id:'egov',name:'eGov',url:'https://egov.kz/',color:'#b69aff'}];
function validUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('Нужен HTTPS-адрес без пароля и нестандартного порта');if(u.hostname==='localhost'||!u.hostname.includes('.')||/^[\d.]+$/.test(u.hostname)||u.hostname.includes(':')||u.hostname.endsWith('.local'))throw Error('Нужен публичный адрес сайта');return u.href;}
function sameOrigin(url,base){try{return new URL(url).origin===new URL(base).origin;}catch{return false;}}
module.exports={defaults,validUrl,sameOrigin};
