class MessagingClient{
 constructor({rpc}){if(typeof rpc!=='function')throw Error('MESSAGING_RPC_REQUIRED');this.rpc=rpc;}
 status(){return this.rpc('adapter_messaging_status',{});}
 poll({limit=20}={}){return this.rpc('adapter_messaging_poll',{limit});}
 ack({eventId}){return this.rpc('adapter_messaging_ack',{eventId});}
 reply({eventId,operationId,text}){return this.rpc('adapter_messaging_reply',{eventId,operationId,text});}
 receipt({operationId}){return this.rpc('adapter_messaging_receipt',{operationId});}
}
module.exports={MessagingClient};
