const {createHash}=require('node:crypto');
function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';return'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
const payloadHash=value=>createHash('sha256').update(canonical(value),'utf8').digest('hex');
module.exports={canonical,payloadHash};
