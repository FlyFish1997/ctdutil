create table shop.t_order (
    order_id varchar(32) comment '订单号',
    buyer_name varchar(50) comment '买家姓名',
    amount decimal(18,4) comment '金额',
    qty int comment '数量',
    order_date date comment '下单日期',
    created_at datetime comment '创建时间'
) comment = '订单主表''含单引号';

alter table shop.t_order add constraint pk_t_order primary key (order_id);

create index idx_t_order_01 on shop.t_order (buyer_name);

create unique index idx_t_order_date on shop.t_order (order_date, qty);
