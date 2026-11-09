import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,expect,it,vi} from "vitest";
const scenario=vi.hoisted(()=>({evidence:null as string|null,count:2}));
vi.mock("@/lib/orders-cache",()=>({
  useOrdersAll:()=>({loading:false,error:null,data:{orders:[
    {id:"card",source:"generic",kind:"order",order_ref:null,merchant_name:"Synthetic card purchase",total_amount:100,order_at:"2026-11-01T12:00:00Z",items:[],txn_id:"txn",review_status:"confirmed",txn:{card_last4:"1234",amount_inr:100,merchant:"Synthetic card purchase",txn_at:"2026-11-01T12:00:00Z"}},
    {id:"voucher",source:"generic",kind:"order",order_ref:null,merchant_name:"Synthetic voucher purchase",total_amount:100,order_at:"2026-11-01T12:00:00Z",items:[],txn_id:null,review_status:"unmatched",txn:null,voucher_draws:scenario.evidence?[{voucherId:"test",amount:100,evidence:scenario.evidence}]:[]},
  ...Array.from({length:Math.max(0,scenario.count-2)},(_,i)=>({id:`extra-${i}`,source:"generic",kind:"order",order_ref:null,merchant_name:`Synthetic extra ${i}`,total_amount:100,order_at:"2026-11-01T12:00:00Z",items:[],txn:null}))
  ]}}),refreshOrdersAll:vi.fn(),
}));
import OrdersTab from "./OrdersTab";
beforeEach(()=>{scenario.count=2;scenario.evidence=null;});
it.each([null,"manual","email","inferred_fifo"])("labels the combined card/voucher count honestly for %s funding", evidence=>{
  scenario.evidence=evidence;
  const html=renderToStaticMarkup(createElement(OrdersTab));
  const tile=html.split('Card or voucher</div>')[1]?.split('</div>')[0];
  expect(tile).toBeDefined();
  expect(tile).toContain(`>${evidence?2:1}`);
  expect(html).not.toContain('Linked to a card</div>');
});

it("keeps a long Orders ledger to ten visible rows without reducing the full-history count",()=>{
  scenario.count=21;
  const html=renderToStaticMarkup(createElement(OrdersTab));
  expect(html.match(/class="order-row /g)).toHaveLength(10);
  expect(html).toContain('aria-label="Next orders page"');
  expect(html.split('All orders</div>')[1]?.split('</div>')[0]).toContain('>21');
});
