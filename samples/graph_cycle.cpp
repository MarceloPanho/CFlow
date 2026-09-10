struct Node {
    int val;
    Node* next;
};

int cycle_sum() {
    Node a;
    Node b;
    Node c;
    a.val = 1;
    b.val = 2;
    c.val = 3;
    a.next = &b;
    b.next = &c;
    c.next = &a;
    Node* p = &a;
    int s = 0;
    for (int i = 0; i < 3; i++) {
        s += p->val;
        p = p->next;
    }
    return s;
}

int main() {
    return cycle_sum();
}
