#include <stack>

int stack_demo() {
    std::stack<int> st;
    st.push(1);
    st.push(2);
    st.push(3);
    int top = st.top();
    st.pop();
    st.pop();
    return top;
}

int main() {
    return stack_demo();
}
